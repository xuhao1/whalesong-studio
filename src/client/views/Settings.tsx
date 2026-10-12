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
import type { ComfyCatalog, BookImageSettings } from '../../shared/types'
import { ASPECTS, DEFAULT_ART_STYLE, KIND_ASPECT, PICTURE_KINDS, PICTURE_TIERS, pictureSize, pixelSize, type PictureKind, type PictureTier } from '../../shared/art'
import { fittedSize, imageService, imageSetupName, imageSizes, imageSourceOf, imageWays, leadOf, LOCAL_SIZES, localImages, portraitsOf, promptWriteOf, sizeList, switchImage, switchTts, withBook, type ImageLimits, type ImageSource, type PictureLead, type PortraitPlan, type PromptWrite } from '../../shared/images'
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
  type BookParallel, type CodexBridgeKind, type ContextSettings, type CrewRole, type CrewRoleSettings, type CrewSettings, type EmbeddingSettings, type GateKind, type ImageSettings, type ModelRoute, type NovelSettings, type SoundProviderKind, type SoundSettings, type TextModelRouting, type TextRole, type TtsProviderKind, type TtsSettings,
} from '../../shared/types'
import { PARALLEL_DEFAULT, PARALLEL_MAX, PASSAGE_CONTEXT_DEFAULT, PLAY_CONTEXT_DEFAULT, REFERENCES_DEFAULT, REFERENCES_MAX, TTS_SERVICE_KEYS, type SoundSettings as SoundDraft } from '../../shared/types'
import { messageOf } from '../api'
import { ImageModelField, ModelField, speechEndpoint, speechSuggestions, useKeyState, type KeyBag, type TypedKeys } from '../ModelField'
import { Icon } from '../icons'
import {
  Button, Chip, Combo, cx, Field, SectionTitle, Select, Spinner, TextArea, TextInput, useAction, useKept, useLoad, useSnapshot, useStudio, useT, type ComboOption, type Translate,
} from '../ui'
import { QuickSetup, Readiness, Signature } from './Setup'

const ROLES: { role: TextRole; label: [string, string]; hint: [string, string] }[] = [
  { role: 'writer', label: ['写手', 'Writer'], hint: ['写正文、续写、改写。选文笔最好的模型。', 'Prose, continuations, rewrites. Pick the best stylist.'] },
  { role: 'analyst', label: ['场记', 'Continuity'], hint: ['收录记忆、审校、整理导入的书稿。选快而稳的模型。', 'Digests, review, sorting an imported manuscript. Pick a fast, steady model.'] },
  { role: 'architect', label: ['策划', 'Planner'], hint: ['推演大纲与节拍、起草设定、查资料。选推理强的模型。', 'Outlines and beats, drafting the bible, research. Pick a strong reasoner.'] },
  { role: 'director', label: ['导演', 'Director'], hint: ['有声脚本、分镜、幕间。选响应快、守得住格式的模型。', 'Scripts, storyboards, interludes. Pick a quick model that keeps to a format.'] },
  { role: 'producer', label: ['后期', 'Post-production'], hint: ['把配音、音效和画面剪成视频。选写代码最稳的模型。', 'Cuts voices, sound and frames into a video. Pick the steadiest coder.'] },
]

const SEPARATOR = ' :: '
const keyOf = (route: Pick<ModelRoute, 'provider' | 'model'>): string => `${route.provider}${SEPARATOR}${route.model}`


/** What a portrait asked for with nothing said of it can come to, in the order they are offered. */
const PORTRAIT_PLANS: readonly PortraitPlan[] = ['both', 'scene', 'plain']

/** Whether somebody's standing look is written out beside a picture that shows it, as a choice reads. */
function looksWord(looks: 'pictured' | 'always', t: (zh: string, en: string) => string): string {
  return looks === 'always' ? t('样子也写一遍', 'written out as well') : t('只引用图，不再写样子', 'pointed to, not written out')
}

function portraitPlanWord(plan: PortraitPlan, t: (zh: string, en: string) => string): string {
  return plan === 'both' ? t('素底定妆 + 名场面，各一张', 'a plain likeness and the signature scene, one of each') : plan === 'scene' ? t('只画名场面', 'the signature scene alone') : t('只画素底定妆', 'a plain likeness alone')
}

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
  '内部工具：工坊给的工具，加上它的活用得上的几样。所有工具：对话里装了的都有。非 agent：一问一答，没有工具。',
  'Its own tools: the Studio\'s, plus the few its work calls for. Every tool: whatever the conversation has. Not an agent: one request, one answer, no tools.',
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
  vision: ['看图', 'Pictures'],
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
  return <SettingsShell view={view} t={t} />
}

/** Which of the two the page showed last, book by book: a form made anew (after a save) opens where it was. */
const scopeShown = new Map<string, 'global' | 'book'>()

/** The form, made anew as well when another book is in hand or the book's own settings changed under the page: what it shows of a book is that book's, as it is now. */
function SettingsShell({ view, t }: { view: SettingsData; t: Translate }) {
  const root = useSnapshot(snapshot => snapshot.root)
  const book = useSnapshot(snapshot => snapshot.project?.manifest)
  const own = book !== undefined ? { models: book.models, crew: book.crew, image: book.image, tts: book.tts, sound: book.sound, embedding: book.embedding, vision: book.vision, context: book.context, parallel: book.parallel } : undefined
  return <SettingsForm key={JSON.stringify([{ ...view.settings, recommended: undefined }, root, own])} view={view} t={t} />
}

/** The reader's own settings, where the Studio's other settings are: the same panel, the same store. */
function ReadingPanel({ t }: { t: Translate }) {
  const [prefs, update] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  return <ReaderSettings prefs={prefs} update={update} options={options} updateOptions={updateOptions} t={t} />
}

const GATE_KINDS: GateKind[] = ['text', 'speech', 'image', 'sound']
const GATE_WORD: Record<GateKind, [string, string]> = { text: ['文字', 'text'], speech: ['语音', 'speech'], image: ['图片', 'pictures'], sound: ['声音', 'sound'] }
const STRATEGY_WORD: Record<ContextSettings['strategy'], [string, string]> = {
  auto: ['梗概 + 尽量多的整章原文', 'outline + as many whole chapters as fit'],
  full: ['原文能塞多少塞多少', 'as much text as the window holds'],
  retrieval: ['不带整章：梗概 + 检索片段', 'no whole chapter: outline + looked-up passages'],
}

/** What a book has of its own, as the page holds it until it is saved into the book. */
interface BookOwn { models: Partial<TextModelRouting>; crew: CrewSettings; image: BookImageSettings; tts?: TtsSettings | undefined; sound?: SoundSettings | undefined; embedding?: EmbeddingSettings | undefined; vision?: ModelRoute | undefined; context: Partial<ContextSettings>; parallel: BookParallel }

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
  const [own, setOwn] = useState<BookOwn>(() => ({ models: book?.models ?? {}, crew: book?.crew ?? {}, image: book?.image ?? {}, context: book?.context ?? {}, parallel: book?.parallel ?? {}, ...(book?.tts !== undefined ? { tts: book.tts } : {}), ...(book?.sound !== undefined ? { sound: book.sound } : {}), ...(book?.embedding !== undefined ? { embedding: book.embedding } : {}), ...(book?.vision !== undefined ? { vision: book.vision } : {}) }))
  const [ownDirty, setOwnDirty] = useState(false)
  const bookHasOwn = book !== undefined && (Object.keys(book.models ?? {}).length > 0 || Object.values(book.crew ?? {}).some(value => value !== undefined && Object.keys(value).length > 0) || Object.keys(book.image ?? {}).length > 0 || book.tts !== undefined || book.sound !== undefined || book.embedding !== undefined || book.vision !== undefined || Object.keys(book.context ?? {}).length > 0 || Object.keys(book.parallel ?? {}).length > 0)
  // A book that has settings of its own is what the page opens on: they are what holds for the book in hand.
  const [wanted, setWanted] = useState<'global' | 'book'>((bookRoot !== undefined ? scopeShown.get(bookRoot) : undefined) ?? (bookHasOwn ? 'book' : 'global'))
  const setScope = (next: 'global' | 'book'): void => {
    if (bookRoot !== undefined) scopeShown.set(bookRoot, next)
    setWanted(next)
  }
  const scope: 'global' | 'book' = wanted === 'book' && book !== undefined && bookRoot !== undefined ? 'book' : 'global'
  const updateOwn = (patch: Partial<BookOwn>): void => {
    setOwn((previous) => {
      const next = { ...previous, ...patch }
      // Named as nothing: the book has none of its own.
      if ('tts' in patch && patch.tts === undefined) delete next.tts
      if ('sound' in patch && patch.sound === undefined) delete next.sound
      if ('embedding' in patch && patch.embedding === undefined) delete next.embedding
      if ('vision' in patch && patch.vision === undefined) delete next.vision
      return next
    })
    setOwnDirty(true)
  }
  // What holds for this book as the page stands: the draft for every book, with the book's own over it.
  const held = withBook(draft, own)
  const bookView = view.book !== undefined && view.book.root === bookRoot ? view.book : undefined
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
    // What the Studio does by itself is set for every book: shown under that view, whichever was open.
    if (part === 'auto') setScope('global')
    if (part === 'image' || part === 'tts' || part === 'sound' || part === 'embedding') setUnfolded(previous => ({ ...previous, [part]: true }))
    // Not taken back when this effect is cleaned up: taking the request off the store (below) renders the page again at
    // once, and that very cleanup used to cancel the scroll it had just asked for. A page that is gone has nothing to find.
    setTimeout(() => {
      const target = page.current?.querySelector(`[data-section="${part}"]`)
      if (target !== null && target !== undefined) {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        target.classList.add('is-focus')
        setTimeout(() => { target.classList.remove('is-focus') }, 2400)
      }
    }, 60)
    controller.consumeSettingsFocus()
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
      // Named as nothing (`null`), speech and sound of its own are taken off the book: the Studio's hold for it again.
      await controller.api.call('project.update', { root: bookRoot, patch: { models: own.models, crew, image: own.image, tts: own.tts ?? null, sound: own.sound ?? null, embedding: own.embedding ?? null, vision: own.vision ?? null, context: Object.keys(own.context).length > 0 ? own.context : null, parallel: Object.keys(own.parallel).length > 0 ? own.parallel : null } as never })
      setOwnDirty(false)
      await controller.refreshProject()
      if (!dirty) {
        await controller.loadSettings()
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
      vision: draft.vision ?? null,
      crew: sectionPatch(view.settings.crew ?? {}, draft.crew ?? {}),
      textConcurrency: draft.textConcurrency ?? null,
      autoDigest: draft.autoDigest,
      siftCast: draft.siftCast !== false,
      plansFollow: draft.plansFollow === true,
      recheckIssues: draft.recheckIssues !== false,
      mendBy: draft.mendBy === 'writer' ? 'writer' : 'planner',
      rewriteBy: draft.rewriteBy === 'planner' ? 'planner' : 'writer',
      mendReach: draft.mendReach === 'careful' ? 'careful' : 'bold',
      settleSuggestions: draft.settleSuggestions !== false,
      reviewAgentRevisions: draft.reviewAgentRevisions,
      agentFiles: draft.agentFiles ?? 'guide',
    }, Object.fromEntries(Object.values(typed).map(entry => [entry.url, entry.value.trim()])))
    controller.toast('success', t('设置已保存', 'Settings saved'))
  })

  // What this book has its own way with, one by one: said at the top of the page, each with the way back.
  const roleWord = (role: string): string => t(...(ROLE_NAME[role] ?? [role, role]))
  const leadWord = (lead: PictureLead): string => (lead === 'portrait' ? t('立绘为准', 'the portrait leads') : lead === 'none' ? t('各画各的', 'neither leads') : t('人设图为准', 'the sheet leads'))
  const portraitWord = (plan: PortraitPlan): string => portraitPlanWord(plan, t)
  // What this book says of its own about what a portrait comes to: as it says it now, or as an older switch said it.
  const ownPortraits: PortraitPlan | undefined = own.image.portraits ?? (own.image.portraitScene === false ? 'plain' : undefined)
  const differing: { key: string; label: string; reset: () => void }[] = [
    ...Object.entries(own.models).filter(([, route]) => route !== undefined).map(([role, route]) => ({ key: `model:${role}`, label: t(`${roleWord(role)}的模型：${route!.model}`, `${roleWord(role)}'s model: ${route!.model}`), reset: () => { const { [role as TextRole]: _old, ...rest } = own.models; updateOwn({ models: rest }) } })),
    ...Object.entries(own.crew).filter(([, value]) => value !== undefined && Object.keys(value).length > 0).map(([role]) => ({ key: `crew:${role}`, label: t(`${roleWord(role)}怎么干活`, `how ${roleWord(role)} works`), reset: () => { const { [role as CrewRole]: _old, ...rest } = own.crew; updateOwn({ crew: rest }) } })),
    ...(own.image.provider !== undefined ? [{ key: 'image:service', label: t(`绘图服务：${own.image.provider === 'none' ? '不画图' : imageSetupName(own.image as ImageSettings)}`, `image service: ${own.image.provider === 'none' ? 'none' : imageSetupName(own.image as ImageSettings)}`), reset: () => { updateOwn({ image: imageWays(own.image) }) } }] : []),
    ...(own.tts !== undefined ? [{ key: 'tts', label: t(`配音服务：${own.tts.provider === 'none' ? '不配音' : own.tts.model ?? own.tts.provider}`, `speech: ${own.tts.provider === 'none' ? 'none' : own.tts.model ?? own.tts.provider}`), reset: () => { updateOwn({ tts: undefined }) } }] : []),
    ...(own.sound !== undefined ? [{ key: 'sound', label: t('声音设计', 'sound design'), reset: () => { updateOwn({ sound: undefined }) } }] : []),
    ...(own.vision !== undefined ? [{ key: 'vision', label: t(`看图的模型：${own.vision.model}`, `looks at pictures: ${own.vision.model}`), reset: () => { updateOwn({ vision: undefined }) } }] : []),
    ...(own.embedding !== undefined ? [{ key: 'embedding', label: t(`检索：${own.embedding.provider === 'none' ? '只按关键词' : own.embedding.model ?? own.embedding.provider}`, `retrieval: ${own.embedding.provider === 'none' ? 'keywords only' : own.embedding.model ?? own.embedding.provider}`), reset: () => { updateOwn({ embedding: undefined }) } }] : []),
    ...(Object.keys(own.parallel).length > 0 ? [{ key: 'parallel', label: t(`并发：${GATE_KINDS.filter(kind => own.parallel[kind] !== undefined).map(kind => `${t(...GATE_WORD[kind])} ${own.parallel[kind]}`).join(' · ')}`, `at once: ${GATE_KINDS.filter(kind => own.parallel[kind] !== undefined).map(kind => `${t(...GATE_WORD[kind])} ${own.parallel[kind]}`).join(' · ')}`), reset: () => { updateOwn({ parallel: {} }) } }] : []),
    ...(Object.keys(own.context).length > 0 ? [{ key: 'context', label: t(`上下文预算：${Object.keys(own.context).length} 项`, `context: ${Object.keys(own.context).length} of its own`), reset: () => { updateOwn({ context: {} }) } }] : []),
    ...(own.image.lead !== undefined ? [{ key: 'image:lead', label: t(`人物的图：${leadWord(own.image.lead)}`, `pictures of people: ${leadWord(own.image.lead)}`), reset: () => { const { lead: _old, ...rest } = own.image; updateOwn({ image: rest }) } }] : []),
    ...(own.image.sheet !== undefined ? [{ key: 'image:sheet', label: own.image.sheet === 'front' ? t('人设图只画正面', 'sheets show the front alone') : t('人设图画三视图', 'sheets show three views'), reset: () => { const { sheet: _old, ...rest } = own.image; updateOwn({ image: rest }) } }] : []),
    ...(ownPortraits !== undefined ? [{ key: 'image:scene', label: t(`立绘：${portraitWord(ownPortraits)}`, `portraits: ${portraitWord(ownPortraits)}`), reset: () => { const { portraitScene: _old, portraits: _was, ...rest } = own.image; updateOwn({ image: rest }) } }] : []),
    ...(own.image.looks !== undefined ? [{ key: 'image:looks', label: t(`有参考图的人物：${looksWord(own.image.looks, t)}`, `people with a picture: ${looksWord(own.image.looks, t)}`), reset: () => { const { looks: _old, ...rest } = own.image; updateOwn({ image: rest }) } }] : []),
    ...(own.image.panelThings !== undefined ? [{ key: 'image:things', label: own.image.panelThings ? t('有声漫带上物品设定图', 'panels take things\' art along') : t('有声漫不带物品设定图', 'panels leave things\' art behind'), reset: () => { const { panelThings: _old, ...rest } = own.image; updateOwn({ image: rest }) } }] : []),
  ]

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
  // What the crew runs on for every book, in a word: said beside "as for every book", so that following it is following something.
  const everywhereModels = CREW_ROLES.map(role => draft.models[role]?.model ?? '')
  const everywhereCrew = everywhereModels.every(model => model === everywhereModels[0]) ? (everywhereModels[0]!.length > 0 ? everywhereModels[0]! : t(`跟随对话模型${view.defaultRoute !== undefined ? `：${view.defaultRoute.model}` : ''}`, `follows the chat model${view.defaultRoute !== undefined ? `: ${view.defaultRoute.model}` : ''}`)) : t('各角色不同', 'differs by role')
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
  const crewRoles = (inBook ? bookView?.roles : undefined) ?? view.crew?.roles ?? []
  const unable = view.crew !== undefined ? crewRoles.filter(item => (CREW_ROLES as readonly string[]).includes(item.role) && !(item.agent && view.crew!.loop)) : []
  // Models this book names that DSH does not list now: the role cannot run on them.
  const unlisted = (bookView?.unlisted ?? []).filter(item => { const mine = own.models[item.role]; return mine !== undefined && mine.provider === item.provider && mine.model === item.model })
  const roleRow = (role: TextRole, label: string, hint: string): ReactNode => {
    const global = draft.models[role]
    const mine = own.models[role]
    return (
      <OwnMark key={`${scope}:${role}`} own={mine !== undefined} scope={scope} t={t} elsewhere={scope === 'global' && mine !== undefined ? t(`《${bookTitle}》另设：${mine.model}`, `"${bookTitle}" has its own: ${mine.model}`) : undefined}>
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
      </OwnMark>
    )
  }

  return (
    <div className={cx('nv-page nv-settings', scope === 'book' && 'is-book')} ref={page}>
      <header className="nv-settings-head">
        <div>
          <h2>{t('小说工坊设置', 'Novel Studio settings')}</h2>
        </div>
        <div className="nv-row-wrap">
          <Button variant="ghost" icon="clock" onClick={() => { controller.setView('usage') }}>{t('用量与成本', 'Usage and cost')}</Button>
          <label className="nv-check nv-advanced-switch" title={t('逐个角色的模型、并发、上下文预算、图片比例', 'Models role by role, concurrency, context budgets, picture shapes')}>
            <input type="checkbox" checked={advanced} onChange={(event) => { setAdvanced(event.target.checked) }} />
            <span>{t('高级选项', 'Advanced')}</span>
          </label>
          <Button variant="primary" busy={busy} disabled={!dirty && !ownDirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>

      <Readiness view={view} t={t} />

      {book !== undefined ? (
        // Whose settings the page shows: those for every book, or what the book in hand has its own way with.
        <section className="nv-card nv-scope-card">
          <div className="nv-scope">
            <span className="nv-scope-label">{t('在看谁的设置', 'Whose settings')}</span>
            <div className="nv-segmented" role="radiogroup">
              <button type="button" role="radio" aria-checked={scope === 'global'} className={cx('nv-segment', scope === 'global' && 'is-active')} onClick={() => { setScope('global') }}>{t('全局：所有的书', 'Every book')}</button>
              <button type="button" role="radio" aria-checked={scope === 'book'} className={cx('nv-segment', scope === 'book' && 'is-active')} onClick={() => { setScope('book') }}>{t(`这本书：《${bookTitle}》`, `This book: "${bookTitle}"`)}{differing.length > 0 ? <span className="nv-own-count">{differing.length}</span> : null}</button>
            </div>
          </div>
          {differing.length > 0 ? (
            <div className="nv-own-list">
              <span className="nv-muted nv-small">{scope === 'book' ? t('和全局不同的：', 'Its own, apart from every book\'s:') : t(`《${bookTitle}》里另设了（盖过这里的）：`, `"${bookTitle}" has its own (which hold over these):`)}</span>
              {differing.map(item => (
                <span key={item.key} className="nv-chip nv-chip-violet nv-own-chip">{item.label}<button type="button" onClick={item.reset} title={t('恢复成全局的', 'Back to what every book has')} aria-label={t('恢复成全局的', 'Back to what every book has')}>×</button></span>
              ))}
            </div>
          ) : <p className="nv-muted nv-small">{scope === 'book' ? t('这本书还没有自己的设置：下面每一项都沿用全局。在这里改的只对这本书生效，随书保存。', 'This book has no settings of its own yet: everything below follows every book\'s. What is changed here holds for this book alone, and is kept with it.') : t('对所有的书生效。', 'For every book.')}</p>}
        </section>
      ) : null}

      <section className="nv-card" data-global="">
        <SectionTitle actions={(
          <>
            <Button size="sm" variant="ghost" icon="sparkles" onClick={() => { controller.setView('setup') }}>{t('引导页', 'Guide')}</Button>
            <Button size="sm" variant="ghost" icon={quick ? 'chevronUp' : 'chevronDown'} onClick={() => { setQuick(value => !value) }}>{quick ? t('收起', 'Hide') : t('展开', 'Show')}</Button>
          </>
        )}>{t('一键配置', 'One-click setup')}</SectionTitle>
        <p className="nv-muted nv-small">{t('贴一个 key，把画图、配音、检索一次配好。', 'One key sets up pictures, voices and search.')}</p>
        {quick || view.setupNeeded ? <QuickSetup view={view} services={['bailian', 'openrouter', 'openai']} /> : (
          <div className="nv-row-wrap">
            {(['bailian', 'openrouter', 'openai'] as const).map(service => <Button key={service} size="sm" onClick={() => { setQuick(true) }}>{t(...SERVICES[service].name)}</Button>)}
            <Button size="sm" onClick={() => { setQuick(true) }}>{t('ChatGPT 订阅（Codex）', 'ChatGPT subscription (Codex)')}</Button>
          </div>
        )}
        <RecommendedCard view={view.recommended} />
      </section>

      <section className="nv-card" data-section="reading" data-global="">
        <SectionTitle>{t('阅读体验', 'Reading')}</SectionTitle>
        
        <ReadingPanel t={t} />
      </section>

      <section className="nv-card" data-section="text">
        <SectionTitle>{t('模型', 'Models')}</SectionTitle>
        <p className="nv-muted nv-small">{t('文字模型来自 DSH 的“设置 → 模型”。总编用对话自己选的模型。', 'Text models come from DSH Settings → Models. The showrunner uses the conversation\'s own model.')}{' '}<button type="button" className="nv-link" onClick={() => controller.guard(async () => { await controller.loadSettings() })}>{t('重新读取 DSH 的模型', 'Read DSH\'s models again')}</button></p>
        {unlisted.length > 0 ? (
          <div className="nv-note is-warn">
            <p>{t(`《${bookTitle}》指定的 ${unlisted.length} 个模型，DSH 里现在没有——这些角色在这本书上跑不起来：`, `"${bookTitle}" names ${unlisted.length} model(s) DSH does not list now — these roles cannot run for this book:`)}</p>
            <ul className="nv-plain-list">
              {unlisted.map(item => (
                <li key={item.role}>
                  {roleWord(item.role)}：<code>{item.model}</code>{t(`（${item.provider}${item.noProvider ? '：DSH 里没有这个提供方了' : '：它现在不列这个模型'}）`, ` (${item.provider}${item.noProvider ? ': DSH no longer has this provider' : ': it does not list this model now'})`)}{' '}
                  <button type="button" className="nv-link" onClick={() => { const { [item.role]: _old, ...rest } = own.models; updateOwn({ models: rest }) }}>{t('改回沿用全局', 'Back to every book\'s')}</button>
                </li>
              ))}
            </ul>
            <p className="nv-small">{t('也可以在下面另选一个；改完点“保存”。', 'Or choose another below; then Save.')}</p>
          </div>
        ) : null}
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
                ? t('场记、策划、导演、后期共用。', 'Shared by the scribe, the planner, the director and post-production.')
                : t('四个角色现在各不相同；在这里选一个就统一。', 'The four roles differ now; choosing one here makes them the same.')}
              route={crewSame ? routeOf(CREW_ROLES[0]!) : undefined}
              models={view.models}
              providers={view.providers ?? []}
              fallback={view.defaultRoute}
              keys={keys}
              t={t}
              {...(!crewSame ? { unset: t('各角色不同——见高级选项', 'Differs by role — see Advanced') } : scope === 'book' ? { unset: t(`沿用全局设置（${everywhereCrew}）`, `As set for every book (${everywhereCrew})`) } : {})}
              extra={view.crew !== undefined ? (
                <Field
                  label={t('agent 能力范围', 'What the crew may do')}
                  hint={`${t(...CREW_WAY_HINT)}${crewWayNow !== 'call' && unable.length > 0 ? t(` ${unable.length} 个角色的模型当不了 agent（${unable.map(item => t(...(ROLE_NAME[item.role] ?? [item.role, item.role]))).join('、')}），按普通调用干活。`, ` ${unable.length} role(s) have a model that cannot drive an agent (${unable.map(item => t(...(ROLE_NAME[item.role] ?? [item.role, item.role]))).join(', ')}); they work by plain calls.`) : ''}`}
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
        {/* Whose model writes the words of a change made by places: a model fit to write chapters is not always fit for a pinned, small change. */}
        {scope !== 'book' ? (
          <div className="nv-form-grid">
            <Field label={t('按处修改由谁写', 'Who writes a change made by places')} hint={t('修审校问题、照引导审校（写作页的“修改一章”）、全书修订、照要求通篇改一章：每一处改好的文字由哪个模型写。', 'Mending issues, a review by a lead, a revision through the book, a chapter revised in place: whose model writes what each place is to read.')}>
              <Select<'writer' | 'planner'>
                value={draft.mendBy === 'writer' ? 'writer' : 'planner'}
                options={[
                  { value: 'planner', label: t('编排模型：策划直接写出改好的文字（默认）', 'The crew\'s: the planner writes the changed words itself (default)') },
                  { value: 'writer', label: t('写手模型：策划定在哪改，写手改写', 'The writer\'s: the planner settles where, the writer rewrites') },
                ]}
                onChange={(value) => { update({ mendBy: value }) }}
              />
            </Field>
            <Field label={t('改写一段、整章重写由谁写', 'Who rewrites a passage or a whole chapter')} hint={t('写作页选中一段的“润色 / 扩写 / 按要求改”，整章重写，以及修复里策划说“得整章重写”的章节。写一章、续写始终是写手。', 'A selected passage polished, expanded or rewritten on the writing page; a chapter written over whole — asked for, or because a mending says places will not do. Writing a chapter and going on with one is always the writer\'s.')}>
              <Select<'writer' | 'planner'>
                value={draft.rewriteBy === 'planner' ? 'planner' : 'writer'}
                options={[
                  { value: 'writer', label: t('写手模型（默认）', 'The writer\'s (default)') },
                  { value: 'planner', label: t('编排模型', 'The crew\'s') },
                ]}
                onChange={(value) => { update({ rewriteBy: value }) }}
              />
            </Field>
            <Field label={t('修改改多少', 'How far a change goes')} hint={t('修审校问题、“修改一章”、全书修订、照要求改一章时改到什么程度。修复按钮旁的小三角里也能切。', 'How far mending an issue, a review by a lead, a revision through the book and a chapter revised in place go. Also under the small triangle beside the mending buttons.')}>
              <Select<'bold' | 'careful'>
                value={draft.mendReach === 'careful' ? 'careful' : 'bold'}
                options={[
                  { value: 'bold', label: t('主动：改到位——露出来的每一处、牵连到的呼应一并改，该重写一段就重写一段（默认）', 'Bold: mended through — every place it shows and what hangs on it, a paragraph rewritten where it takes one (default)') },
                  { value: 'careful', label: t('保守：能少改就少改，一处能解决的不改两处', 'Careful: the least change — one place where one will do') },
                ]}
                onChange={(value) => { update({ mendReach: value }) }}
              />
            </Field>
          </div>
        ) : null}
        <VisionRow
          route={scope === 'book' ? own.vision : draft.vision}
          models={view.models}
          providers={view.providers}
          working={(['writer', 'architect'] as const).map(role => ({ name: roleWord(role), model: ((scope === 'book' ? bookView?.context : undefined) ?? view.context ?? []).find(row => row.role === role)?.model }))}
          {...(scope === 'book' ? { unset: t(`沿用全局设置（${draft.vision !== undefined ? draft.vision.model : '不配'}）`, `As set for every book (${draft.vision !== undefined ? draft.vision.model : 'none'})`) } : {})}
          t={t}
          onChange={(vision) => {
            if (scope === 'book') updateOwn({ vision })
            else {
              setDraft(({ vision: _old, ...rest }) => (vision !== undefined ? { ...rest, vision } : rest))
              setDirty(true)
            }
          }}
        />
        {advanced ? ROLES.map((item) => {
          const role = item.role
          const crewRole = (CREW_ROLES as readonly string[]).includes(role) && view.crew !== undefined ? role as CrewRole : undefined
          if (crewRole === undefined) return <div key={role} className="nv-role-block">{roleRow(role, t(...item.label), t(...item.hint))}</div>
          return ((role: CrewRole) => {
            const info = crewRoles.find(item => item.role === role)
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
                    hint={`${t(...CREW_WAY_HINT)}${info !== undefined && info.own.length > 0 ? t(` 内部工具里来自对话的：${info.own.join('、')}。`, ` Of the conversation's tools, its own: ${info.own.join(', ')}.`) : ''}`}
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
                  <Field label={t('最多几步', 'Step limit')} hint={t(`一次运行最多调用几次工具。留空：${info?.steps ?? 40}`, `How many tool calls one run may make. Empty: ${info?.steps ?? 40}`)}>
                    <TextInput inputMode="numeric" value={set.steps !== undefined ? String(set.steps) : ''} placeholder={String((inBook ? everywhere.steps : undefined) ?? info?.steps ?? 40)} onChange={(event) => { const value = number(event.target.value); change({ steps: value !== undefined && value >= 4 ? Math.round(value) : undefined }) }} />
                  </Field>
                </div>
              </div>
            )
          })(crewRole)
        }) : null}
        {advanced && view.crew !== undefined ? <p className="nv-muted nv-small">{t('每一次运行都是当前对话的一个子 agent。无论给多少工具，书稿只能通过工坊的工具改。', 'Each run is a subagent of the conversation. Whatever tools it has, the manuscript changes only through the Studio\'s.')}</p> : null}
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
            {view.crew.helpers === undefined ? <p className="nv-muted nv-small">{t('外援：在 DSH 的“设置 → 插件”里添加 @deepseek-ai/dsh-subagent-claude-code 或 @deepseek-ai/dsh-subagent-codex。', 'Outside help: add @deepseek-ai/dsh-subagent-claude-code or @deepseek-ai/dsh-subagent-codex under DSH Settings → Plugins.')}</p> : null}
            {!view.crew.ffmpeg ? <p className="nv-note is-warn">{t(`剪视频和验收都要用 ffmpeg / ffprobe，这台电脑上没有找到。${FFMPEG_INSTALL[0]}。`, `Cutting and checking a video needs ffmpeg / ffprobe, and they were not found on this computer. ${FFMPEG_INSTALL[1]}.`)}</p> : null}
          </div>
        ) : null}
      </section>

      {/* What the Studio does by itself once text is written or changed: each a switch, on the first page — every one of them is model calls nobody pressed a button for. */}
      <section className="nv-card" data-section="auto" data-global="">
        <SectionTitle>{t('自动做的事', 'Done by itself')}</SectionTitle>
        <p className="nv-muted nv-small">{t('正文写了、改了之后，工坊自己接着做的。每一项都是模型调用；关掉的，要用时自己点。', 'What follows by itself once text is written or changed. Each is model calls; what is off waits for your press.')}</p>
        <label className="nv-check">
          <input type="checkbox" checked={draft.autoDigest} onChange={(event) => { update({ autoDigest: event.target.checked }) }} />
          <span>{t('写完或改完一章后自动收录', 'Digest a chapter once it is written or changed')}</span>
        </label>
        <p className="nv-muted nv-small nv-check-note">{draft.autoDigest
          ? t('每章一次场记调用：整章正文，加人物和设定的名单。', 'One call of the scribe a chapter: its whole text, and the lists of people and entries.')
          : t('关着：记忆、人物履历、线索、龙套名单不再自己更新；没收录的章，后面的写作照它的章纲和带得上的正文。要收录：总览页或写作页的“收录”。', 'Off: memory, lives, threads and the list of walk-ons are no longer kept up by themselves; a chapter not digested is known to later writing by its outline and by what of its text fits. To digest: "Digest" on the overview or the writing page.')}</p>
        <label className="nv-check">
          <input type="checkbox" checked={draft.siftCast !== false} onChange={(event) => { update({ siftCast: event.target.checked }) }} />
          <span>{t('收录之后，让策划筛一遍没立卡的新名字', 'After digests, have the planner look through the new names without a card')}</span>
        </label>
        <p className="nv-muted nv-small nv-check-note">{t('策划是 agent，会去书里查：有新名字时，这一趟比收录本身贵得多。', 'The planner is an agent and looks things up in the book: where there are new names, this costs far more than the digest itself.')}</p>
        <label className="nv-check">
          <input type="checkbox" checked={draft.settleSuggestions !== false} onChange={(event) => { update({ settleSuggestions: event.target.checked }) }} />
          <span>{t('设定建议由策划审定后自动收进（不勾：逐条等我采纳）', 'Suggestions for the bible are settled by the planner and entered (off: each waits for me)')}</span>
        </label>
        <label className="nv-check">
          <input type="checkbox" checked={draft.plansFollow === true} onChange={(event) => { update({ plansFollow: event.target.checked }) }} />
          <span>{t('正文改了之后，自动照正文改章纲和节拍', 'Once a chapter\'s text is changed, its plan and beats are set by the text by themselves')}</span>
        </label>
        <p className="nv-muted nv-small nv-check-note">{t('默认不勾：章纲是你定的，写出来的正文不自己变成章纲。要更新，在那一章的章纲上点“照正文更新章纲”。', 'Off unless you tick it: the plan is your design, and text that was written does not become it by itself. To set a plan by its text, press Update the plan from the text on that chapter\'s plan.')}</p>
        <label className="nv-check">
          <input type="checkbox" checked={draft.recheckIssues !== false} onChange={(event) => { update({ recheckIssues: event.target.checked }) }} />
          <span>{t('采纳修订之后，自动核对这一章还开着的审校意见', 'After a revision is accepted, have the issues still open in that chapter checked against the new text')}</span>
        </label>
      </section>

      {scope === 'book' ? (
        <section className="nv-card" data-section="book-image">
          <SectionTitle actions={bookView !== undefined ? <Chip tone={bookView.ready.image && !ownDirty ? 'green' : 'neutral'}>{ownDirty ? t('保存后生效', 'applies on save') : bookView.ready.image ? t('可用', 'ready') : t('还不能用', 'not ready')}</Chip> : undefined}>{t('图像：这本书自己的', 'Pictures: this book\'s own')}</SectionTitle>
          <OwnMark own={own.image.provider !== undefined} scope={scope} t={t}>
            <Field label={t('绘图服务', 'Image service')} hint={own.image.provider !== undefined ? t('这本书的图都用下面这个服务画。密钥按接口地址保存在本机，不进书里。', 'This book\'s pictures are drawn with the service below. Keys are kept on this machine by address, never in the book.') : undefined}>
              <Select<'' | 'own'> value={own.image.provider !== undefined ? 'own' : ''} options={[
                { value: '', label: t(`沿用全局：${draft.image.provider === 'none' ? '不画图' : imageSetupName(draft.image)}`, `As for every book: ${draft.image.provider === 'none' ? 'off' : imageSetupName(draft.image)}`) },
                { value: 'own', label: t('这本书用自己的绘图服务', 'A service of this book\'s own') },
              ]} onChange={(next) => {
                // Starts from what every book draws with — a copy to change — and goes back to it by letting go of the copy.
                if (next === 'own') updateOwn({ image: { ...imageService(draft.image), ...own.image } })
                else updateOwn({ image: imageWays(own.image) })
              }} />
            </Field>
          </OwnMark>
          {own.image.provider !== undefined ? (
            <div className="nv-own is-own nv-own-block">
              <ImageSection value={own.image as ImageSettings} keys={keys} t={t} advanced={advanced} only="service" onChange={(image) => { updateOwn({ image }) }} />
            </div>
          ) : null}
          <div className="nv-form-grid">
            <OwnMark own={own.image.lead !== undefined} scope={scope} t={t}>
              <Field label={t('人物的图以哪张为准', 'Which picture of a person leads')}>
                <Select<PictureLead | ''> value={own.image.lead ?? ''} options={[
                  { value: '', label: t(`沿用全局：${leadWord(leadOf(draft.image))}`, `As for every book: ${leadWord(leadOf(draft.image))}`) },
                  { value: 'sheet', label: t('人设图为准', 'The design sheet') },
                  { value: 'portrait', label: t('立绘为准', 'The portrait') },
                  { value: 'none', label: t('各画各的', 'Neither') },
                ]} onChange={(lead) => { const { lead: _old, ...rest } = own.image; updateOwn({ image: lead === '' ? rest : { ...rest, lead } }) }} />
              </Field>
            </OwnMark>
            <OwnMark own={own.image.sheet !== undefined} scope={scope} t={t}>
              <Field label={t('人设图画什么', 'What a design sheet shows')} hint={t('小的绘图模型画不好并排的三个视图时，选只画正面', 'Where a small image model cannot keep three views alike: the front alone')}>
                <Select<'turn' | 'front' | ''> value={own.image.sheet ?? ''} options={[
                  { value: '', label: t(`沿用全局：${draft.image.sheet === 'front' ? '只画正面' : '三视图'}`, `As for every book: ${draft.image.sheet === 'front' ? 'the front alone' : 'three views'}`) },
                  { value: 'turn', label: t('三视图：正面、侧面、背面', 'Three views: front, side, back') },
                  { value: 'front', label: t('只画正面一个人', 'The front view alone') },
                ]} onChange={(sheet) => { const { sheet: _old, ...rest } = own.image; updateOwn({ image: sheet === '' ? rest : { ...rest, sheet } }) }} />
              </Field>
            </OwnMark>
            <OwnMark own={ownPortraits !== undefined} scope={scope} t={t}>
              <Field label={t('立绘画什么', 'What a portrait comes to')}>
                <Select<PortraitPlan | ''> value={ownPortraits ?? ''} options={[
                  { value: '', label: t(`沿用全局：${portraitWord(portraitsOf(draft.image))}`, `As for every book: ${portraitWord(portraitsOf(draft.image))}`) },
                  ...PORTRAIT_PLANS.map(plan => ({ value: plan, label: portraitWord(plan) })),
                ]} onChange={(value) => { const { portraitScene: _old, portraits: _was, ...rest } = own.image; updateOwn({ image: value === '' ? rest : { ...rest, portraits: value } }) }} />
              </Field>
            </OwnMark>
            <OwnMark own={own.image.panelThings !== undefined} scope={scope} t={t}>
              <Field label={t('有声漫的画面带不带物品设定图', 'Things\' art with a motion comic\'s panels')}>
                <Select<'yes' | 'no' | ''> value={own.image.panelThings === undefined ? '' : own.image.panelThings ? 'yes' : 'no'} options={[
                  { value: '', label: t(`沿用全局：${draft.image.panelThings === false ? '不带' : '带上'}`, `As for every book: ${draft.image.panelThings === false ? 'left behind' : 'taken along'}`) },
                  { value: 'yes', label: t('带上', 'Taken along') },
                  { value: 'no', label: t('不带', 'Left behind') },
                ]} onChange={(value) => { const { panelThings: _old, ...rest } = own.image; updateOwn({ image: value === '' ? rest : { ...rest, panelThings: value === 'yes' } }) }} />
              </Field>
            </OwnMark>
            <OwnMark own={own.image.looks !== undefined} scope={scope} t={t}>
              <Field label={t('有参考图的人物', 'People whose picture goes along')}>
                <Select<'pictured' | 'always' | ''> value={own.image.looks ?? ''} options={[
                  { value: '', label: t(`沿用全局：${looksWord(draft.image.looks ?? 'pictured', t)}`, `As for every book: ${looksWord(draft.image.looks ?? 'pictured', t)}`) },
                  { value: 'pictured', label: looksWord('pictured', t) },
                  { value: 'always', label: looksWord('always', t) },
                ]} onChange={(value) => { const { looks: _old, ...rest } = own.image; updateOwn({ image: value === '' ? rest : { ...rest, looks: value } }) }} />
              </Field>
            </OwnMark>
          </div>
        </section>
      ) : null}

      {scope === 'book' ? (
        <section className="nv-card" data-section="book-tts">
          <SectionTitle actions={bookView !== undefined ? <Chip tone={bookView.ready.tts && !ownDirty ? 'green' : 'neutral'}>{ownDirty ? t('保存后生效', 'applies on save') : bookView.ready.tts ? t('可用', 'ready') : t('还不能用', 'not ready')}</Chip> : undefined}>{t('语音：这本书自己的', 'Speech: this book\'s own')}</SectionTitle>
          <OwnMark own={own.tts !== undefined} scope={scope} t={t}>
            <Field label={t('配音服务', 'Speech service')} hint={own.tts !== undefined ? t('这本书的配音都用下面这一套：服务、模型、旁白、默认音色。', 'This book is voiced with the setup below: service, model, narrator, default voices.') : undefined}>
              <Select<'' | 'own'> value={own.tts !== undefined ? 'own' : ''} options={[
                { value: '', label: t(`沿用全局：${draft.tts.provider === 'none' ? '不配音' : draft.tts.model ?? draft.tts.provider}`, `As for every book: ${draft.tts.provider === 'none' ? 'off' : draft.tts.model ?? draft.tts.provider}`) },
                { value: 'own', label: t('这本书用自己的配音服务', 'A setup of this book\'s own') },
              ]} onChange={(next) => { const { kept: _kept, ...copy } = draft.tts; updateOwn({ tts: next === 'own' ? copy : undefined }) }} />
            </Field>
          </OwnMark>
          {own.tts !== undefined ? (
            <div className="nv-own is-own nv-own-block">
              <TtsSection value={own.tts} keys={keys} voices={(bookView?.voices ?? view.voices).map(voice => ({ id: voice.id, note: `${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}` }))} savedProvider={book?.tts?.provider ?? view.settings.tts.provider} t={t} onChange={(tts) => { updateOwn({ tts }) }} />
            </div>
          ) : null}
          <OwnMark own={own.sound !== undefined} scope={scope} t={t}>
            <Field label={t('声音设计：环境声、音效、配乐', 'Sound design: ambience, effects, music')}>
              <Select<'' | 'own'> value={own.sound !== undefined ? 'own' : ''} options={[
                { value: '', label: t(`沿用全局：${(draft.sound?.provider ?? 'auto') === 'none' ? '不生成' : (draft.sound?.provider ?? 'auto') === 'auto' ? '跟随语音' : draft.sound?.model ?? '单独的接口'}`, `As for every book: ${(draft.sound?.provider ?? 'auto') === 'none' ? 'off' : (draft.sound?.provider ?? 'auto') === 'auto' ? 'follows speech' : draft.sound?.model ?? 'its own endpoint'}`) },
                { value: 'own', label: t('这本书自己定', 'This book\'s own') },
              ]} onChange={(next) => { updateOwn({ sound: next === 'own' ? { ...(draft.sound ?? { provider: 'auto' }) } : undefined }) }} />
            </Field>
          </OwnMark>
          {own.sound !== undefined ? (
            <div className="nv-own is-own nv-own-block">
              <SoundSection value={own.sound} tts={held.tts} ready={bookView?.ready.sound === true} keys={keys} t={t} onChange={(sound) => { updateOwn({ sound }) }} />
            </div>
          ) : null}
        </section>
      ) : null}

      {scope === 'book' ? (
        <section className="nv-card" data-section="book-embedding">
          <SectionTitle actions={bookView !== undefined && own.embedding !== undefined ? <Chip tone={bookView.ready.embedding && !ownDirty ? 'green' : 'neutral'}>{ownDirty ? t('保存后生效', 'applies on save') : bookView.ready.embedding ? t('可用', 'ready') : own.embedding.provider === 'none' ? t('只按关键词', 'keywords only') : t('还不能用', 'not ready')}</Chip> : undefined}>{t('检索：这本书自己的', 'Retrieval: this book\'s own')}</SectionTitle>
          <OwnMark own={own.embedding !== undefined} scope={scope} t={t}>
            <Field label={t('语义检索（向量）', 'Semantic retrieval (embeddings)')} hint={own.embedding !== undefined ? t('这本书的段落用下面这个模型建索引；换了模型，索引在下次检索时重建。', 'This book\'s passages are indexed with the model below; another model rebuilds the index on the next search.') : undefined}>
              <Select<'' | 'own'> value={own.embedding !== undefined ? 'own' : ''} options={[
                { value: '', label: t(`沿用全局：${draft.embedding.provider === 'none' ? '只按关键词' : draft.embedding.model ?? draft.embedding.provider}`, `As for every book: ${draft.embedding.provider === 'none' ? 'keywords only' : draft.embedding.model ?? draft.embedding.provider}`) },
                { value: 'own', label: t('这本书用自己的', 'This book\'s own') },
              ]} onChange={(next) => { updateOwn({ embedding: next === 'own' ? { ...draft.embedding } : undefined }) }} />
            </Field>
          </OwnMark>
          {own.embedding !== undefined ? (
            <div className="nv-own is-own nv-own-block">
              <EmbeddingSection value={own.embedding} keys={keys} t={t} onChange={(embedding) => { updateOwn({ embedding }) }} />
            </div>
          ) : null}
          {!advanced && Object.keys(own.parallel).length === 0 && Object.keys(own.context).length === 0 ? <p className="nv-muted nv-small">{t('并发、上下文预算也能随书：打开右上角的“高级选项”。', 'How much at once and the context budgets can be this book\'s own too: turn on Advanced, top right.')}</p> : null}
        </section>
      ) : null}

      {scope === 'book' && (advanced || Object.keys(own.parallel).length > 0) ? (
        <section className="nv-card" data-section="book-parallel">
          <SectionTitle>{t('并发：这本书自己的', 'How much at once: this book\'s own')}</SectionTitle>
          <p className="nv-muted nv-small">{t(`填了数的那一类，这本书的请求单独计数；留空沿用全局。最多 ${PARALLEL_MAX}。`, `A kind given a number is counted for this book alone; left empty it follows every book's. ${PARALLEL_MAX} at most.`)}</p>
          <div className="nv-form-grid">
            {GATE_KINDS.map((kind) => {
              const everywhere = kind === 'text' ? draft.textConcurrency : kind === 'speech' ? held.tts.concurrency : kind === 'image' ? held.image.concurrency : held.sound?.concurrency
              const one = kind === 'image' && localImages(held.image)
              return (
                <OwnMark key={kind} own={own.parallel[kind] !== undefined} scope={scope} t={t}>
                  <Field label={kind === 'text' ? t('文字：同时进行几件活', 'Text: pieces of work at once') : kind === 'speech' ? t('语音：同时合成几句', 'Speech: lines at once') : kind === 'image' ? t('图片：同时画几张', 'Images: pictures at once') : t('声音：同时生成几处', 'Sound: clips at once')} hint={one ? t('你自己的服务一次画一张', 'A server of your own draws one at a time') : kind === 'sound' && own.parallel.sound === undefined && (held.sound?.provider ?? 'auto') === 'auto' ? t('留空：和语音共用一个数', 'Empty: shares the speech number') : undefined}>
                    {one
                      ? <TextInput disabled value="1" />
                      : <TextInput inputMode="numeric" value={own.parallel[kind] !== undefined ? String(own.parallel[kind]) : ''} placeholder={t(`沿用全局：${everywhere ?? PARALLEL_DEFAULT}`, `As for every book: ${everywhere ?? PARALLEL_DEFAULT}`)} onChange={(event) => { const value = parallel(event.target.value); const { [kind]: _old, ...rest } = own.parallel; updateOwn({ parallel: value !== undefined ? { ...rest, [kind]: value } : rest }) }} />}
                  </Field>
                </OwnMark>
              )
            })}
          </div>
        </section>
      ) : null}

      {scope === 'book' && (advanced || Object.keys(own.context).length > 0) ? (
        <section className="nv-card" data-section="book-context">
          <SectionTitle>{t('上下文：这本书自己的', 'Context: this book\'s own')}</SectionTitle>
          <div className="nv-form-grid">
            <OwnMark own={own.context.strategy !== undefined} scope={scope} t={t}>
              <Field label={t('前文怎么给', 'How the story so far travels')}>
                <Select<ContextSettings['strategy'] | ''> value={own.context.strategy ?? ''} options={[
                  { value: '', label: t(`沿用全局：${t(...STRATEGY_WORD[draft.context.strategy])}`, `As for every book: ${t(...STRATEGY_WORD[draft.context.strategy])}`) },
                  ...(['auto', 'full', 'retrieval'] as const).map(value => ({ value, label: t(...STRATEGY_WORD[value]) })),
                ]} onChange={(strategy) => { const { strategy: _old, ...rest } = own.context; updateOwn({ context: strategy === '' ? rest : { ...rest, strategy } }) }} />
              </Field>
            </OwnMark>
            {([
              ['budgetTokens', t('前文原文的预算（tokens）', 'Budget for the text itself (tokens)'), draft.context.budgetTokens !== undefined ? String(draft.context.budgetTokens) : t('窗口的一半', 'half the window'), 2000],
              ['tailChars', t('没有整章时带上的上文（字符）', 'Preceding text when no chapter is whole (characters)'), String(draft.context.tailChars), 0],
              ['sideTokens', t('设定、线索、检索片段一共占多少（tokens）', 'Bible, threads and looked-up passages together (tokens)'), draft.context.sideTokens !== undefined ? String(draft.context.sideTokens) : t('窗口的 22%', '22% of the window'), 1],
              ['playTokens', t('幕间每一回合带多少上下文（tokens）', 'Context of each turn of an interlude (tokens)'), String(draft.context.playTokens ?? PLAY_CONTEXT_DEFAULT), 1],
              ['passageTokens', t('改写选中的一段带多少上下文（tokens）', 'Context a selected passage is rewritten with (tokens)'), String(draft.context.passageTokens ?? PASSAGE_CONTEXT_DEFAULT), 1],
            ] as const).map(([key, label, everywhere, least]) => (
              <OwnMark key={key} own={own.context[key] !== undefined} scope={scope} t={t}>
                <Field label={label}>
                  <TextInput inputMode="numeric" value={own.context[key] !== undefined ? String(own.context[key]) : ''} placeholder={t(`沿用全局：${everywhere}`, `As for every book: ${everywhere}`)} onChange={(event) => { const value = number(event.target.value); const { [key]: _old, ...rest } = own.context; updateOwn({ context: value !== undefined && value >= (key === 'tailChars' ? 0 : 1) ? { ...rest, [key]: Math.max(least, Math.round(value)) } : rest }) }} />
                </Field>
              </OwnMark>
            ))}
          </div>
          {bookView !== undefined && bookView.context.length > 0 ? (
            <div className="nv-context-rows">
              <span className="nv-muted nv-small">{t('按已保存的设置，这本书各角色现在是：', 'With the settings as saved, each role gets for this book:')}</span>
              {bookView.context.map(row => (
                <Chip key={row.role} tone={row.window !== undefined ? 'blue' : 'amber'}>
                  {t(...(ROLE_NAME[row.role] ?? [row.role, row.role]))}{row.model !== undefined ? ` · ${row.model}` : ''} · {t(`窗口 ${compact(row.window ?? 200_000)} → 原文 ${compact(row.textBudget)}`, `window ${compact(row.window ?? 200_000)} → text ${compact(row.textBudget)}`)}
                </Chip>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {advanced ? (
      <section className="nv-card" data-section="parallel" data-global="">
        <SectionTitle>{t('并发：同时发出多少个请求', 'How much at once')}</SectionTitle>
        <p className="nv-muted nv-small">{t(`每一类请求同时最多发出几个。默认 ${PARALLEL_DEFAULT}，最多 ${PARALLEL_MAX}；被限流时自动降速重试。`, `How many requests of each kind go out at once. ${PARALLEL_DEFAULT} by default, ${PARALLEL_MAX} at most; when rate-limited it slows down and retries.`)}</p>
        {Object.keys(book?.parallel ?? {}).length > 0 ? <p className="nv-own-note">{t(`《${bookTitle}》另设了自己的并发（${GATE_KINDS.filter(kind => book?.parallel?.[kind] !== undefined).map(kind => `${t(...GATE_WORD[kind])} ${book?.parallel?.[kind]}`).join(' · ')}），那几类单独计数。`, `"${bookTitle}" has numbers of its own (${GATE_KINDS.filter(kind => book?.parallel?.[kind] !== undefined).map(kind => `${t(...GATE_WORD[kind])} ${book?.parallel?.[kind]}`).join(' · ')}), counted apart.`)}</p> : null}
        <div className="nv-form-grid">
          <Field label={t('语音：同时合成几句', 'Speech: lines at once')}>
            <TextInput inputMode="numeric" value={draft.tts.concurrency !== undefined ? String(draft.tts.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { update({ tts: without(draft.tts, 'concurrency', parallel(event.target.value)) }) }} />
          </Field>
          <Field label={t('图片：同时画几张', 'Images: pictures at once')} hint={localImages(draft.image) ? t('你自己的服务一次画一张', 'A server of your own draws one at a time') : undefined}>
            {localImages(draft.image)
              ? <TextInput disabled value="1" />
              : <TextInput inputMode="numeric" value={draft.image.concurrency !== undefined ? String(draft.image.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { update({ image: without(draft.image, 'concurrency', parallel(event.target.value)) }) }} />}
          </Field>
          <Field label={t('声音：同时生成几处', 'Sound: clips at once')} hint={(draft.sound?.provider ?? 'auto') === 'auto' ? t('声音沿用语音的模型时，和语音共用上面那个数', 'While sound rides on the speech model, it shares the speech number') : undefined}>
            <TextInput inputMode="numeric" value={draft.sound?.concurrency !== undefined ? String(draft.sound.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} disabled={(draft.sound?.provider ?? 'auto') === 'auto'} onChange={(event) => { update({ sound: without<SoundDraft, 'concurrency'>(draft.sound ?? { provider: 'auto' }, 'concurrency', parallel(event.target.value)) }) }} />
          </Field>
          <Field label={t('文字：同时进行几件活', 'Text: pieces of work at once')} hint={t('一件活：一段脚本、一章收录、一章审校……', 'One piece of work: a script, a chapter\'s digest, a chapter\'s review…')}>
            <TextInput inputMode="numeric" value={draft.textConcurrency !== undefined ? String(draft.textConcurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { const value = parallel(event.target.value); setDraft(({ textConcurrency: _old, ...rest }) => (value !== undefined ? { ...rest, textConcurrency: value } : rest)); setDirty(true) }} />
          </Field>
        </div>
      </section>
      ) : null}

      {advanced ? (
      <section className="nv-card" data-section="context" data-global="">
        <SectionTitle>{t('上下文与记忆', 'Context and memory')}</SectionTitle>
        <p className="nv-muted nv-small">{t('写一章时带的前文：最近若干整章的原文，加更早章节的梗概。', 'What a chapter is written with: the latest chapters whole, and summaries of the ones before.')}</p>
        {Object.keys(book?.context ?? {}).length > 0 ? <p className="nv-own-note">{t(`《${bookTitle}》另设了 ${Object.keys(book?.context ?? {}).length} 项自己的上下文预算，那几项这里的对它不生效。`, `"${bookTitle}" has ${Object.keys(book?.context ?? {}).length} context budget(s) of its own; for those, what is set here does not hold for it.`)}</p> : null}
        <div className="nv-form-grid">
          <Field label={t('前文怎么给', 'How the story so far travels')}>
            <Select value={draft.context.strategy} options={[
              { value: 'auto', label: t('梗概 + 尽量多的整章原文（推荐）', 'Outline + as many whole chapters as fit (recommended)') },
              { value: 'full', label: t('原文能塞多少塞多少（用满窗口）', 'As much text as the window holds at all') },
              { value: 'retrieval', label: t('不带整章：梗概 + 检索片段（最省）', 'No whole chapter: outline + looked-up passages (cheapest)') },
            ]} onChange={(value) => { update({ context: { ...draft.context, strategy: value } }) }} />
          </Field>
          <Field label={t('前文原文的预算（tokens）', 'Budget for the text itself (tokens)')} hint={t('留空：模型窗口的一半', 'Empty: half the model\'s window')}>
            <TextInput inputMode="numeric" value={draft.context.budgetTokens !== undefined ? String(draft.context.budgetTokens) : ''} placeholder={t('窗口的一半', 'half the window')} disabled={draft.context.strategy !== 'auto'} onChange={(event) => { const value = number(event.target.value); update({ context: without(draft.context, 'budgetTokens', value !== undefined && value > 0 ? Math.max(2000, Math.round(value)) : undefined) }) }} />
          </Field>
          <Field label={t('没有整章时带上的上文（字符）', 'Preceding text when no chapter is whole (characters)')} hint={t('只在不带整章原文时用：上一章结尾原样带上的长度', 'Only when no whole chapter travels: how much of the end of the chapter before is carried word for word')}>
            <TextInput inputMode="numeric" value={String(draft.context.tailChars)} onChange={(event) => { const value = number(event.target.value); if (value !== undefined) update({ context: { ...draft.context, tailChars: Math.max(0, Math.round(value)) } }) }} />
          </Field>
          <Field label={t('设定、线索、检索片段一共占多少（tokens）', 'Bible, threads and looked-up passages together (tokens)')} hint={t('留空：模型窗口的 22%，最多 12 万', 'Empty: 22% of the window, 120k at most')}>
            <TextInput inputMode="numeric" value={draft.context.sideTokens !== undefined ? String(draft.context.sideTokens) : ''} placeholder={t('窗口的 22%', '22% of the window')} onChange={(event) => { const value = number(event.target.value); const { sideTokens: _old, ...rest } = draft.context; update({ context: value !== undefined && value > 0 ? { ...rest, sideTokens: Math.round(value) } : rest }) }} />
          </Field>
          <Field label={t('幕间每一回合带多少上下文（tokens）', 'Context of each turn of an interlude (tokens)')} hint={t(`留空：${PLAY_CONTEXT_DEFAULT.toLocaleString()}`, `Empty: ${PLAY_CONTEXT_DEFAULT.toLocaleString()}`)}>
            <TextInput inputMode="numeric" value={draft.context.playTokens !== undefined ? String(draft.context.playTokens) : ''} placeholder={String(PLAY_CONTEXT_DEFAULT)} onChange={(event) => { const value = number(event.target.value); const { playTokens: _old, ...rest } = draft.context; update({ context: value !== undefined && value > 0 ? { ...rest, playTokens: Math.round(value) } : rest }) }} />
          </Field>
          <Field label={t('改写选中的一段带多少上下文（tokens）', 'Context a selected passage is rewritten with (tokens)')} hint={t(`设定、人物、这一章前后的故事；这一章自己在那一段前后的文字另算。留空：${PASSAGE_CONTEXT_DEFAULT.toLocaleString()}`, `The bible, the people, the story around its chapter; the chapter's own text around the passage comes besides. Empty: ${PASSAGE_CONTEXT_DEFAULT.toLocaleString()}`)}>
            <TextInput inputMode="numeric" value={draft.context.passageTokens !== undefined ? String(draft.context.passageTokens) : ''} placeholder={String(PASSAGE_CONTEXT_DEFAULT)} onChange={(event) => { const value = number(event.target.value); const { passageTokens: _old, ...rest } = draft.context; update({ context: value !== undefined && value > 0 ? { ...rest, passageTokens: Math.round(value) } : rest }) }} />
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
          <input type="checkbox" checked={draft.reviewAgentRevisions} onChange={(event) => { update({ reviewAgentRevisions: event.target.checked }) }} />
          <span>{t('总编发起的正文修订先作为提案，等我确认后才生效', 'Revisions requested by the showrunner wait as proposals until I accept them')}</span>
        </label>
        <Field label={t('总编想绕过工坊、直接用文件工具改书的文件时', 'When the showrunner reaches for a book\'s files with raw file tools')} hint={t('总编改书有专门的工具，每次改动都留版本、记进改动记录。直接写文件会绕过这些。', 'The showrunner changes a book through its tools, which keep versions and a record. Writing files directly goes round them.')}>
          <Select<'guide' | 'ask' | 'allow'> value={draft.agentFiles ?? 'guide'} options={[
            { value: 'guide', label: t('拦下，并告诉它该用哪个工具（推荐）', 'Refuse, and name the tool to use (recommended)') },
            { value: 'ask', label: t('每次问我', 'Ask me each time') },
            { value: 'allow', label: t('放行，事后对账', 'Let it through, reconcile afterwards') },
          ]} onChange={(agentFiles) => { update({ agentFiles }) }} />
        </Field>
      </section>
      ) : null}

      <Fold id="image" title={t('图像生成', 'Image generation')} summary={draft.image.provider === 'none' ? t('未使用', 'off') : `${draft.image.provider === 'codex' ? t('ChatGPT 订阅', 'ChatGPT subscription') : draft.image.model ?? draft.image.provider}${view.ready.image ? '' : t(' · 还不能用', ' · not ready')}`} ready={view.ready.image} {...fold('image')}>
        <p className="nv-muted nv-small">{t('立绘、插图、封面、分镜画面都用它。', 'Portraits, illustrations, covers and panels all use it.')}</p>
        {book?.image?.provider !== undefined ? <p className="nv-own-note">{t(`《${bookTitle}》另设了自己的绘图服务（${book.image.provider === 'none' ? '不画图' : imageSetupName(book.image as ImageSettings)}），这里的对它不生效。`, `"${bookTitle}" has an image service of its own (${book.image.provider === 'none' ? 'off' : imageSetupName(book.image as ImageSettings)}); what is set here does not hold for it.`)}</p> : null}
        <ImageSection value={draft.image} keys={keys} t={t} advanced={advanced} onChange={(image) => { update({ image }) }} />
      </Fold>

      <Fold id="tts" title={t('语音合成', 'Speech')} summary={draft.tts.provider === 'none' ? t('未使用', 'off') : `${draft.tts.model ?? draft.tts.provider}${view.ready.tts ? '' : t(' · 还不能用', ' · not ready')}`} ready={view.ready.tts} {...fold('tts')}>
        <p className="nv-muted nv-small">{t('同一人物全书用同一个声音：人物卡指定的优先，其次自动选角。', 'One voice per person through the book: the one on their card first, else cast automatically.')}</p>
        {book?.tts !== undefined ? <p className="nv-own-note">{t(`《${bookTitle}》另设了自己的配音服务（${book.tts.provider === 'none' ? '不配音' : book.tts.model ?? book.tts.provider}），这里的对它不生效。`, `"${bookTitle}" has a speech setup of its own (${book.tts.provider === 'none' ? 'off' : book.tts.model ?? book.tts.provider}); what is set here does not hold for it.`)}</p> : null}
        <TtsSection value={draft.tts} keys={keys} voices={view.voices.map(voice => ({ id: voice.id, note: `${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}` }))} savedProvider={view.settings.tts.provider} t={t} onChange={(tts) => { update({ tts }) }} />
      </Fold>

      <Fold id="sound" title={t('声音设计：环境声、音效、配乐', 'Sound design: ambience, effects, music')} summary={(draft.sound?.provider ?? 'auto') === 'none' ? t('未使用', 'off') : (draft.sound?.provider ?? 'auto') === 'auto' ? t('沿用语音的模型', 'rides on the speech model') : draft.sound?.model ?? String(draft.sound?.provider)} ready={view.ready.sound === true} {...fold('sound')}>
        <p className="nv-muted nv-small">{t('环境声、音效和配乐：显示成正文旁的注释，也可以生成出来垫在人声下面。', 'Ambience, effects and music: shown as notes beside the text, or generated to lie under the voices.')}</p>
        <SoundSection value={draft.sound ?? { provider: 'auto' }} tts={draft.tts} ready={view.ready.sound === true} keys={keys} t={t} onChange={(sound) => { update({ sound }) }} />
      </Fold>

      <Fold id="embedding" title={t('语义检索（向量）', 'Semantic retrieval (embeddings)')} summary={draft.embedding.provider === 'none' ? t('未使用：按关键词检索', 'off: keyword retrieval') : draft.embedding.model ?? draft.embedding.provider} ready={view.ready.embedding} {...fold('embedding')}>
        <p className="nv-muted nv-small">{t('不配置时按关键词检索；配置后两者混合排序。', 'Without it, search is by keyword; with it, the two are ranked together.')}</p>
        {book?.embedding !== undefined ? <p className="nv-own-note">{t(`《${bookTitle}》另设了自己的检索（${book.embedding.provider === 'none' ? '只按关键词' : book.embedding.model ?? book.embedding.provider}），这里的对它不生效。`, `"${bookTitle}" has retrieval of its own (${book.embedding.provider === 'none' ? 'keywords only' : book.embedding.model ?? book.embedding.provider}); what is set here does not hold for it.`)}</p> : null}
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
    <section className={cx('nv-card nv-fold', open && 'is-open')} data-section={id} data-global="">
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

function describeCheck(check: EndpointCheck, t: Translate): string {
  // The count is of text models; an endpoint that has none — an image server — is not said to have "0 models".
  const models = check.models !== undefined && check.models > 0 ? check.models : undefined
  if (check.ok) return t(`密钥可用${models !== undefined ? `（${models} 个模型）` : ''}`, `The key works${models !== undefined ? ` (${models} models)` : ''}`)
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
    ? t('从启动 DSH 的环境里按这个名字读取密钥。', 'The key is read by this name from the environment that starts DSH.')
    : state?.configured === true && typed.length === 0
      ? t(`${host} 的密钥已保存。留空沿用，填写则更换。`, `The key for ${host} is saved. Leave empty to keep it, type to replace it.`)
      : t(`只对 ${host} 生效，保存在本机的 DSH 凭据库里。`, `Used for ${host} only; stored in DSH credential store on this machine.`)
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

function EndpointField({ value, placeholder, hint, onChange, t }: { value: string; placeholder: string; hint?: string | undefined; onChange: (value: string | undefined) => void; t: Translate }) {
  return (
    <Field label={t('接口地址', 'Endpoint')} hint={hint}>
      <TextInput value={value} spellCheck={false} placeholder={placeholder} onChange={(event) => { onChange(event.target.value.trim().length > 0 ? event.target.value.trim() : undefined) }} />
    </Field>
  )
}

// ───────────────────────────── text roles ─────────────────────────────

/**
 * The model that looks at pictures for a role whose own model cannot: one of DSH's, with those that say they take
 * pictures listed first. Beside it, what the writer's and the planner's own models say of themselves — where they see,
 * this one is not asked.
 */
function VisionRow({ route, models, providers, working, unset, onChange, t }: {
  route: ModelRoute | undefined
  models: ModelOption[]
  providers: ProviderOption[]
  /** The roles that are given pictures, and the model each runs on. */
  working: { name: string; model?: string | undefined }[]
  /** What "none chosen" means here, when it is not "none": a book's row falls back on the Studio-wide one. */
  unset?: string
  onChange: (route: ModelRoute | undefined) => void
  t: Translate
}) {
  const of = (provider: string): ModelOption[] => models.filter(model => model.provider === provider)
  const mine = route !== undefined ? of(route.provider) : []
  const picked = route !== undefined ? mine.find(model => model.id === route.model) : undefined
  const seeing = t('说自己能看图的', 'Say they take pictures')
  const sight = (model: string | undefined): boolean | undefined => (model !== undefined ? models.find(candidate => candidate.id === model)?.sees : undefined)
  return (
    <div className="nv-role-block" data-section="vision">
      <div className="nv-form-grid">
        <Field label={t('看图的模型', 'Looks at pictures')} hint={t('给推演、写作配了参考图，而干活的模型自己看不了图时，由它先把图看成文字。不配的话，那样的模型只拿到每张图的标题。', 'Where pictures are given to a plan or a chapter and the model doing the work takes none, this one says in words what they show. With none set up, such a model is told only what each picture is called.')}>
          <Select value={route?.provider ?? ''} options={[
            { value: '', label: unset ?? t('不配：看不了图的模型只拿到图的标题', 'None: a model that takes no pictures is told what they are called') },
            ...providers.map(provider => ({ value: provider.id, label: provider.name })),
          ]} onChange={(provider) => {
            if (provider === '') onChange(undefined)
            // The first of its models that says it sees; else the first it lists, to be changed.
            else onChange({ provider, model: (of(provider).find(model => model.sees === true) ?? of(provider)[0])?.id ?? '' })
          }} />
        </Field>
        {route !== undefined ? (
          <Field label={t('模型', 'Model')} hint={picked?.sees === true ? t('它说自己能看图', 'It says it takes pictures') : picked?.sees === false ? t('它说自己看不了图：换一个', 'It says it takes no pictures: choose another') : t('它没有声明能不能看图', 'It does not say whether it takes pictures')}>
            <Combo value={route.model} placeholder={t('模型名', 'model id')} options={[...mine].sort((left, right) => Number(right.sees === true) - Number(left.sees === true)).map((model): ComboOption => ({ value: model.id, ...(model.name !== model.id && model.name.length > 0 ? { label: model.name } : {}), ...(model.sees === true ? { group: seeing } : { group: t('其它', 'Others'), ...(model.sees === false ? { note: t('看不了图', 'no pictures') } : {}) }) }))} onChange={(model) => { onChange({ provider: route.provider, model }) }} />
          </Field>
        ) : null}
      </div>
      <p className="nv-muted nv-small">
        {working.map(role => `${role.name}${role.model !== undefined ? `（${role.model}）` : ''}${sight(role.model) === true ? t('自己能看图', ' takes pictures itself') : sight(role.model) === false ? t('看不了图', ' takes no pictures') : t('没有声明能不能看图', ' does not say whether it takes pictures')}`).join(t('；', '; '))}
        {t('。自己能看图的直接看，用不到上面这个。', '. One that takes pictures looks itself; the model above is not asked for it.')}
      </p>
    </div>
  )
}

/** Where a role's model comes from: the chat model, one of the providers the Harness reaches (`harness:<id>`), or an endpoint named here. */
type RoleSource = '' | `harness:${string}` | ServiceId

/**
 * A setting, marked where the book in hand has its own way with it: under the book's settings, that this one is the
 * book's own; under those for every book, that the book has another (`elsewhere`), which is what holds for it.
 */
function OwnMark({ own, scope, elsewhere, t, children }: { own: boolean; scope: 'global' | 'book'; elsewhere?: string | undefined; t: Translate; children: ReactNode }) {
  if (scope === 'book' && own) return <div className="nv-own is-own"><span className="nv-own-tag">{t('本书', 'This book')}</span>{children}</div>
  if (scope === 'global' && elsewhere !== undefined) return <div className="nv-own is-elsewhere">{children}<p className="nv-own-note">{elsewhere}</p></div>
  return <>{children}</>
}

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
  const outputHint = `${follows}${details.data?.maxOutput !== undefined ? t(`（这个模型最大 ${kilo(details.data.maxOutput)}）`, ` (this model writes at most ${kilo(details.data.maxOutput)})`) : ''}${t('。思考也算在这个数里，填小了会被截断。', '. Reasoning counts towards it; set low, output is cut off.')}`
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
                {t('这个角色还在用旧的直连接口，只能按普通调用干活。把这家的模型接进 DSH 的“设置 → 模型”，再回来选它。', 'This role still uses an old direct endpoint and can only work by plain calls. Connect that provider under DSH Settings → Models, then choose it here.')}
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
                ? t(`${provider.name} 现在列不出模型（${provider.error.slice(0, 80)}）。可以直接填模型名。`, `${provider.name} cannot list its models now (${provider.error.slice(0, 80)}). A model name can be typed in.`)
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
              <Field label={t('上下文窗口（tokens）', 'Context window (tokens)')} hint={route.contextWindow !== undefined ? t('按你填的算', 'Using your figure') : detected !== undefined ? t(`已识别为 ${Math.round(detected / 1000)}k，一般不用填`, `Detected as ${Math.round(detected / 1000)}k; usually no need to fill in`) : t('没能识别这个模型的窗口，先按 200k 算；更大就填上', 'This model\'s window is not known; 200k is assumed. Enter it if it is larger')}>
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
function PictureSizeFields({ value, onChange, t, advanced, limits }: { value: ImageSettings; onChange: (next: ImageSettings) => void; t: Translate; advanced: boolean; /** What the author's own server says its model draws at most, where it was asked. */ limits?: ImageLimits }) {
  // No fineness chosen: every kind of picture at the size it has always had.
  const tier = (PICTURE_TIERS as readonly string[]).includes(value.resolution ?? '') ? value.resolution as PictureTier : undefined
  const aspects = value.aspects ?? {}
  const setAspect = (kind: PictureKind, next: string | undefined): void => {
    const { [kind]: _old, ...rest } = aspects
    const merged = next !== undefined && next.length > 0 ? { ...rest, [kind]: next } : rest
    const { aspects: _all, ...others } = value
    onChange(Object.keys(merged).length > 0 ? { ...others, aspects: merged } : others)
  }
  // An endpoint that draws only some sizes: each kind of picture comes to the one nearest in shape — or, where the
  // author's own server said how large its model draws and no sizes are listed, to the largest of its shape.
  const within = limits !== undefined && sizeList(value.sizes).length === 0 && localImages(value) ? limits : undefined
  const only = within !== undefined ? undefined : imageSizes(value)
  const across = (size: string): string => size.replace('x', '×')
  return (
    <>
      <Field label={t('清晰度', 'Fineness')} hint={within !== undefined
        ? t(`这台服务器最大画到 ${within.maxWidth}×${within.maxHeight}：每类图片取自己形状里最大的。`, `This server draws up to ${within.maxWidth}×${within.maxHeight}: each kind of picture gets the largest of its shape.`)
        : only !== undefined
        ? t(`这个接口只画 ${only.map(across).join('、')}：每类图片取形状最近的一种。`, `This endpoint draws ${only.map(across).join(', ')} only: each kind of picture gets the nearest in shape.`)
        : tier === undefined
        ? t('默认：每类图片各用自己的常用尺寸。', 'Default: each kind of picture at its usual size.')
        : t(`所有图片共用，按各自的比例分配（16:9 就是 ${pixelSize('16:9', tier).replace('x', '×')}）。模型不支持时会报错，换低一档。`, `For every picture, shaped by its own ratio (16:9 is ${pixelSize('16:9', tier).replace('x', '×')}). A model that cannot do it says so: step down.`)}>
        <Select value={tier ?? ''} options={[{ value: '', label: t('默认（各类图片的常用尺寸）', 'Default (each kind\'s usual size)') }, ...PICTURE_TIERS.map(item => ({ value: item as string, label: t(...TIER_LABELS[item]) }))]} onChange={(next) => { onChange(without(value, 'resolution', next)) }} />
      </Field>
      {/* The shape of each kind of picture: for whoever wants other than a standing cover and a lying stage. */}
      {!advanced ? null : (
      <div className="nv-size-grid">
        {PICTURE_KINDS.map((kind) => {
          const chosen = aspects[kind]
          const custom = chosen !== undefined && !(ASPECTS as readonly string[]).includes(chosen)
          return (
            <Field key={kind} label={t(...KIND_LABELS[kind])} hint={custom && only === undefined && within === undefined ? t('宽x高，如 1600x900', 'WIDTHxHEIGHT, e.g. 1600x900') : fittedSize(value, pictureSize(value, kind), within).replace('x', ' × ')}>
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

/**
 * ComfyUI: the address, what the server there has to draw with — asked of it, so that nobody types a file name from
 * memory —, and what to draw with: a workflow, or a model the built-in graph can load.
 */
function ComfyFields({ value, onChange, t }: { value: ImageSettings; onChange: (value: ImageSettings) => void; t: Translate }) {
  const { controller } = useStudio()
  const [server, setServer] = useState<{ catalog?: ComfyCatalog; error?: string } | undefined>()
  const [asking, setAsking] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const address = value.baseURL?.trim() ?? ''
  const connect = (): void => {
    setAsking(true)
    controller.api.call('image.comfy', address.length > 0 ? { baseURL: address } : {})
      .then((catalog) => { setServer({ catalog }) })
      // (A Host from before cannot ask: said as it is.)
      .catch((error: unknown) => { setServer({ error: messageOf(error) }) })
      .finally(() => { setAsking(false) })
  }
  // Asked once as the form opens; again on the author's word, after the address changed or a model was added.
  useEffect(() => {
    connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const catalog = server?.catalog
  const set = <K extends keyof ImageSettings>(key: K, next: ImageSettings[K] | undefined): void => { onChange(without(value, key, next)) }
  const typed = (key: 'baseURL' | 'model' | 'workflow' | 'editWorkflow', placeholder: string) => ({ value: value[key] ?? '', placeholder, onChange: (event: { target: { value: string } }) => { set(key, event.target.value.length > 0 ? event.target.value : undefined) } })
  const workflow = value.workflow?.trim() ?? ''
  // Kept in the settings as the JSON itself: taken from the server — a workflow saved there, or its last run.
  const keptIn = (source: string | undefined): { nodes: number; images: number; from?: string } | undefined => {
    const text = source?.trim() ?? ''
    if (!text.startsWith('{')) return undefined
    try {
      const graph = JSON.parse(text) as Record<string, unknown>
      const from = (graph._novel as { from?: unknown } | undefined)?.from
      const places = text.match(/%image(\d+)%/g) ?? []
      return { nodes: Object.keys(graph).filter(key => key !== '_novel').length, images: new Set(places).size, ...(typeof from === 'string' ? { from } : {}) }
    } catch {
      return { nodes: 0, images: 0 }
    }
  }
  const kept = keptIn(value.workflow)
  const keptEdit = keptIn(value.editWorkflow)
  const [taking, setTaking] = useState(false)
  // A workflow saved on the server, taken as it is: one that loads pictures is the one for pictures with references, any other the plain one.
  const take = (path: string): void => {
    if (path.length === 0) return
    setTaking(true)
    controller.api.call('image.comfyTake', { ...(address.length > 0 ? { baseURL: address } : {}), path })
      .then((taken) => {
        onChange({ ...value, [taken.images > 0 ? 'editWorkflow' : 'workflow']: taken.workflow })
        controller.toast('success', taken.images > 0
          ? t(`已取来「${path}」：它带 ${taken.images} 张参考图，放进了"带参考图的工作流"。保存后生效。`, `Taken "${path}": it loads ${taken.images} reference picture(s), so it is the workflow for pictures with references. It holds once saved.`)
          : t(`已取来「${path}」，放进了"工作流"。保存后生效。`, `Taken "${path}" as the workflow. It holds once saved.`))
      })
      .catch((error: unknown) => { controller.toast('error', messageOf(error)) })
      .finally(() => { setTaking(false) })
  }
  const keptLine = (found: { nodes: number; images: number; from?: string }, clear: () => void): ReactNode => (
    <div className="nv-row">
      <span className="nv-muted nv-small">{t(
        `存在设置里：${found.from !== undefined ? `${found.from === 'the server\'s last run' ? '服务器上次的运行' : found.from} · ` : ''}${found.nodes} 个节点${found.images > 0 ? ` · ${found.images} 张参考图` : ''}`,
        `Kept in the settings: ${found.from !== undefined ? `${found.from} · ` : ''}${found.nodes} nodes${found.images > 0 ? ` · ${found.images} reference picture(s)` : ''}`)}</span>
      <Button size="sm" variant="ghost" icon="x" onClick={clear}>{t('清除', 'Clear')}</Button>
    </div>
  )
  const model = value.model?.trim() ?? ''
  const listed = catalog !== undefined ? [...catalog.checkpoints, ...catalog.diffusion] : []
  const alone = catalog !== undefined && catalog.diffusion.includes(model)
  const choice = (list: readonly string[], current: string | undefined, none: string) => [{ value: '', label: none }, ...list.map(name => ({ value: name, label: name })), ...(current !== undefined && current.length > 0 && !list.includes(current) ? [{ value: current, label: current }] : [])]
  const adopt = (): void => {
    setAdopting(true)
    controller.api.call('image.comfyAdopt', address.length > 0 ? { baseURL: address } : {})
      .then((last) => {
        onChange({ ...value, workflow: last.workflow, ...(last.model !== undefined ? { model: last.model } : {}) })
        controller.toast('success', t(`已取来：${last.nodes.length} 个节点${last.model !== undefined ? `，模型 ${last.model}` : ''}。保存后生效。`, `Taken: ${last.nodes.length} nodes${last.model !== undefined ? `, model ${last.model}` : ''}. It holds once saved.`))
      })
      .catch((error: unknown) => { controller.toast('error', messageOf(error)) })
      .finally(() => { setAdopting(false) })
  }
  return (
    <>
      <Field label={t('地址', 'Address')}>
        <div className="nv-row">
          <TextInput {...typed('baseURL', 'http://127.0.0.1:8188')} />
          <Button size="sm" icon="refresh" busy={asking} pending={t('正在连接…', 'Connecting…')} onClick={connect}>{t('连接', 'Connect')}</Button>
        </div>
        {catalog !== undefined ? (
          <p className="nv-muted nv-small">
            {['ComfyUI', catalog.version, catalog.device].filter(Boolean).join(' · ')}
            {t(` — checkpoint ${catalog.checkpoints.length}，扩散模型 ${catalog.diffusion.length}，文本编码器 ${catalog.encoders.length}，VAE ${catalog.vaes.length}`, ` — ${catalog.checkpoints.length} checkpoints, ${catalog.diffusion.length} diffusion models, ${catalog.encoders.length} text encoders, ${catalog.vaes.length} VAEs`)}
          </p>
        ) : server?.error !== undefined ? <p className="nv-note is-warn nv-small">{server.error}</p> : null}
      </Field>
      {catalog !== undefined && catalog.workflows.length > 0 ? (
        <Field label={t('服务器上存的工作流', 'Workflows saved on the server')} hint={t('选一个就取来用：带参考图的放进"带参考图的工作流"，其余放进"工作流"', 'Choose one to use it: one that loads pictures becomes the workflow for pictures with references, any other the plain one')}>
          <div className="nv-row">
            <Select value="" options={[{ value: '', label: taking ? t('正在取…', 'Taking it…') : t('选一个…', 'Choose one…') }, ...catalog.workflows.map(path => ({ value: path, label: path.replace(/\.json$/i, '') }))]} onChange={take} />
          </div>
        </Field>
      ) : null}
      <Field label={t('工作流', 'Workflow')} hint={kept !== undefined ? t('没有参考图的图（人设图、设定图）用它', 'For pictures without references: design sheets, places') : t('这台电脑上 API 格式导出的 JSON 文件，里面写 %prompt%、%negative_prompt%、%width%、%height%、%seed%；留空用内置流程', 'A JSON file on this computer, exported in API format, with %prompt%, %negative_prompt%, %width%, %height%, %seed% in it; empty: the built-in graph')}>
        {kept !== undefined ? keptLine(kept, () => { set('workflow', undefined) }) : <TextInput {...typed('workflow', '~/ComfyUI/user/default/workflows/novel.json')} />}
        {kept === undefined && workflow.length === 0 && catalog?.last !== undefined ? (
          <div className="nv-row">
            <span className="nv-muted nv-small">{t(`这台服务器上次跑成功的一次：${catalog.last.model ?? ''}（${catalog.last.nodes.length} 个节点）`, `The server's last run that made a picture: ${catalog.last.model ?? ''} (${catalog.last.nodes.length} nodes)`)}</span>
            <Button size="sm" icon="download" busy={adopting} pending={t('正在取…', 'Taking it…')} onClick={adopt} title={t('把那一次的工作流取来当模板：提示词、尺寸、种子换成工坊填的，模型和采样照它的', 'Take that run as the template: prompt, size and seed become the Studio\'s to fill, models and sampling stay its own')}>{t('用它当工作流', 'Use it as the workflow')}</Button>
          </div>
        ) : null}
      </Field>
      <Field label={t('模型', 'Model')} hint={workflow.length > 0 ? t('工作流里的 %model%；工作流自己写了模型时不用填', '%model% in the workflow; not needed where the workflow names its own') : catalog === undefined ? t('内置流程用的模型文件名；连接后可以从服务器上选', 'The model file the built-in graph loads; once connected it is chosen from the server\'s') : undefined}>
        {catalog !== undefined && listed.length > 0
          ? <Select value={model} options={[{ value: '', label: t('（未选）', '(none)') }, ...catalog.checkpoints.map(name => ({ value: name, label: `checkpoint · ${name}` })), ...catalog.diffusion.map(name => ({ value: name, label: t(`扩散模型 · ${name}`, `diffusion model · ${name}`) })), ...(model.length > 0 && !listed.includes(model) ? [{ value: model, label: model }] : [])]} onChange={(next) => { set('model', next.length > 0 ? next : undefined) }} />
          : <TextInput {...typed('model', 'sd_xl_base_1.0.safetensors')} />}
      </Field>
      {alone && workflow.length === 0 && catalog !== undefined ? (
        <>
          <Field label={t('文本编码器', 'Text encoder')}><Select value={value.textEncoder ?? ''} options={choice(catalog.encoders, value.textEncoder, catalog.encoders.length === 1 ? catalog.encoders[0]! : t('（请选）', '(choose)'))} onChange={(next) => { set('textEncoder', next.length > 0 ? next : undefined) }} /></Field>
          <Field label={t('编码器类型', 'Encoder kind')} hint={t('这个模型属于哪一族', 'The family the model is of')}><Select value={value.encoderType ?? ''} options={choice(catalog.encoderTypes, value.encoderType, t('（请选）', '(choose)'))} onChange={(next) => { set('encoderType', next.length > 0 ? next : undefined) }} /></Field>
          <Field label="VAE"><Select value={value.vae ?? ''} options={choice(catalog.vaes, value.vae, catalog.vaes.length === 1 ? catalog.vaes[0]! : t('（请选）', '(choose)'))} onChange={(next) => { set('vae', next.length > 0 ? next : undefined) }} /></Field>
        </>
      ) : null}
      <Field label={t('带参考图的工作流', 'Workflow with reference pictures')} hint={keptEdit !== undefined ? t('有参考图的图（照人设图画立绘、画面里有人）用它', 'For pictures with references: a portrait against a design sheet, a scene with people in it') : t('这台电脑上的文件，用 %image1%、%image2% 载入参考图；留空则不带参考图', 'A file on this computer that loads them as %image1%, %image2%; empty: reference pictures do not go along')}>
        {keptEdit !== undefined ? keptLine(keptEdit, () => { set('editWorkflow', undefined) }) : <TextInput {...typed('editWorkflow', '~/ComfyUI/user/default/workflows/novel-edit.json')} />}
      </Field>
    </>
  )
}

/**
 * The sizes an endpoint draws, typed as a list. What is typed stays as typed while it is typed — a comma is not taken
 * away from under the cursor — and what it comes to goes into the settings.
 */
function SizeListField({ value, placeholder, onChange, t }: { value: string[] | undefined; placeholder: string; onChange: (sizes: string[] | undefined) => void; t: Translate }) {
  const [text, setText] = useState(() => (value ?? []).join(', '))
  const held = (value ?? []).join(',')
  // Changed from elsewhere — another service chosen, the settings loaded again: show that.
  useEffect(() => { setText(current => (sizeList(current).join(',') === held ? current : held.replace(/,/g, ', '))) }, [held])
  return (
    <Field label={t('它画得了的尺寸', 'The sizes it draws')} hint={t('每张图取形状最近的一种', 'Each picture gets the nearest in shape')}>
      <TextInput value={text} spellCheck={false} placeholder={placeholder} onChange={(event) => {
        setText(event.target.value)
        const sizes = sizeList(event.target.value)
        onChange(sizes.length > 0 ? sizes : undefined)
      }} />
    </Field>
  )
}

function ImageSection({ value, keys, onChange, t, advanced, only }: { value: ImageSettings; keys: KeyBag; onChange: (value: ImageSettings) => void; t: Translate; advanced: boolean; /** `service`: the service alone — where it comes from and what it is asked for — without the ways of drawing that hold whichever service draws. */ only?: 'service' }) {
  const source = imageSourceOf(value)
  const { codex } = keys.view
  const all = only !== 'service'
  // What a service starts out with the first time it is chosen; one that was set up before comes back as it was left.
  const fresh = (next: ImageSource): Partial<ImageSettings> => (
    next === 'none' ? { provider: 'none' }
      : next === 'codex' ? { provider: 'codex', size: '1536x1024' }
        : next === 'comfyui' || next === 'diffusers' ? { provider: next, size: value.size ?? '1024x1024' }
          : next === 'custom' ? { provider: 'openai', baseURL: '', model: '', size: value.size ?? '1024x1024' }
            : imageService(recommendedSetup(next)!.image))
  const pick = (next: ImageSource): void => { if (next !== source) onChange(switchImage(value, next, fresh(next))) }
  const endpoint = value.provider === 'dashscope' ? value.baseURL ?? SERVICES.bailian.origin : value.provider === 'openrouter' ? value.baseURL ?? compatibleBase('openrouter') : value.baseURL ?? compatibleBase('openai')
  // On this machine: no key, no list of models to choose from.
  const local = value.provider === 'comfyui' || value.provider === 'diffusers'
  const text = (key: 'baseURL' | 'model' | 'workflow' | 'editWorkflow' | 'python', placeholder: string) => ({ value: value[key] ?? '', placeholder, onChange: (event: { target: { value: string } }) => { onChange(without(value, key, event.target.value.length > 0 ? event.target.value : undefined)) } })
  const figure = (key: 'steps' | 'guidance') => ({ value: value[key] !== undefined ? String(value[key]) : '', onChange: (event: { target: { value: string } }) => { const given = Number(event.target.value); onChange(without(value, key, event.target.value.trim().length > 0 && Number.isFinite(given) && given >= 0 ? given : undefined)) } })
  const viaConnect = codex.connect && codex.connectSignedIn
  const viaCli = codex.cli && codex.cliSignedIn
  const ready = value.bridge === 'connect' ? viaConnect : value.bridge === 'cli' ? viaCli : viaConnect || viaCli
  // A server of the author's own behind the custom endpoint: told by its address, and said outright where that misleads.
  const own = localImages(value)
  // What that server's own list says of the model chosen: how large it draws.
  const [listed, setListed] = useState<EndpointModel[]>([])
  const limits = own ? listed.find(model => model.id === value.model)?.image : undefined
  const setOwn = (next: boolean): void => {
    const { local: _old, ...rest } = value
    onChange(localImages(rest) === next ? rest : { ...rest, local: next })
  }
  return (
    <>
      <div className="nv-form-grid">
        <Field label={t('服务', 'Service')}>
          <Select<ImageSource> value={source} options={([
            { value: 'none', label: t('不使用', 'Off') },
            { value: 'openrouter', label: t('OpenRouter（GPT Image 2.5 等，推荐）', 'OpenRouter (GPT Image 2.5 and more, recommended)') },
            { value: 'codex', label: t('ChatGPT 订阅（Codex，无需 key）', 'ChatGPT subscription (Codex, no key)') },
            { value: 'openai', label: t('OpenAI（GPT Image）', 'OpenAI (GPT Image)') },
            { value: 'bailian', label: t('阿里云百炼（Qwen-Image、万相、Z-Image）', 'Aliyun Bailian (Qwen-Image, Wan, Z-Image)') },
            { value: 'custom', label: t('自定义接口（OpenAI 兼容；也可以是你自己的服务器）', 'Custom endpoint (OpenAI-compatible; a server of your own too)') },
            { value: 'comfyui', label: t('ComfyUI（本机）', 'ComfyUI (this machine)') },
            { value: 'diffusers', label: t('Diffusers（本机的 Python）', 'Diffusers (this machine\'s Python)') },
          ] as { value: ImageSource; label: string }[]).map(option => (value.kept?.[option.value] !== undefined && option.value !== source ? { ...option, label: t(`${option.label} · 配过，换回去还在`, `${option.label} · set up before, kept`) } : option))} onChange={pick} />
        </Field>
        {value.provider === 'codex' ? (
          <Field label={t('通道', 'Bridge')} hint={ready ? t('这条通道已登录，可以出图', 'This bridge is signed in and can draw') : value.bridge === 'cli' ? t('还没有登录：在终端运行 codex login，选择用 ChatGPT 登录', 'Not signed in yet: run codex login in a terminal and sign in with ChatGPT') : value.bridge === 'connect' ? t('还没有登录：在 DSH 设置 → 模型 → Openai-Codex 里授权', 'Not signed in yet: authorize under DSH Settings → Models → Openai-Codex') : t('还没有登录：在 DSH 设置 → 模型 → Openai-Codex 授权，或运行 codex login', 'Not signed in yet: authorize under DSH Settings → Models → Openai-Codex, or run codex login')}>
            <Select<CodexBridgeKind> value={value.bridge ?? 'auto'} options={[
              { value: 'auto', label: t('自动（优先 Codex Connect）', 'Automatic (Codex Connect first)') },
              { value: 'connect', label: `Codex Connect${codex.connect ? (codex.connectSignedIn ? t(' · 已登录', ' · signed in') : t(' · 未登录', ' · not signed in')) : t(' · 未安装', ' · not installed')}` },
              { value: 'cli', label: `Codex CLI${codex.cli ? (codex.cliSignedIn ? t(' · 已登录', ' · signed in') : t(' · 未登录', ' · not signed in')) : t(' · 未安装', ' · not installed')}` },
            ]} onChange={(bridge) => { onChange(without(value, 'bridge', bridge === 'auto' ? undefined : bridge)) }} />
          </Field>
        ) : null}
        {value.provider === 'comfyui' ? <ComfyFields value={value} onChange={onChange} t={t} /> : null}
        {value.provider === 'diffusers' ? (
          <>
            <Field label={t('模型', 'Model')} hint={t('Hugging Face 上的名字，或本机的文件夹 / .safetensors 路径', 'A Hugging Face id, or a folder or .safetensors path on this computer')}><TextInput {...text('model', 'stabilityai/stable-diffusion-xl-base-1.0')} /></Field>
            <Field label="Python" hint={t('装了 diffusers 和 torch 的那个', 'The one that has diffusers and torch')}><TextInput {...text('python', 'python3')} /></Field>
            <Field label={t('设备', 'Device')}>
              <Select value={value.device ?? 'auto'} options={[{ value: 'auto', label: t('自动', 'Automatic') }, { value: 'cuda', label: 'CUDA' }, { value: 'mps', label: 'MPS (Apple)' }, { value: 'cpu', label: 'CPU' }]} onChange={(device) => { onChange(without(value, 'device', device === 'auto' ? undefined : device)) }} />
            </Field>
          </>
        ) : null}
        {local ? (
          <>
            <Field label={t('步数', 'Steps')} hint={value.provider === 'comfyui' ? t('内置流程用；留空：照服务器上这个模型上次跑的，没有就 25', 'For the built-in graph; empty: as the server last ran this model, else 25') : t('留空用模型自己的', 'Empty: the pipeline\'s own')}><TextInput inputMode="numeric" {...figure('steps')} /></Field>
            <Field label={t('引导强度（CFG）', 'Guidance (CFG)')} hint={value.provider === 'comfyui' ? t('内置流程用；留空：照服务器上这个模型上次跑的，没有就 checkpoint 7、扩散模型 3.5', 'For the built-in graph; empty: as the server last ran this model, else 7 for a checkpoint and 3.5 for a diffusion model') : t('留空用模型自己的', 'Empty: the pipeline\'s own')}><TextInput inputMode="decimal" {...figure('guidance')} /></Field>
          </>
        ) : null}
        {value.provider !== 'none' && value.provider !== 'codex' && !local ? (
          <>
            <EndpointField value={value.baseURL ?? ''} placeholder={endpoint} hint={value.provider === 'dashscope' ? t('百炼的域名；专属域名也可以', 'The Bailian domain; a workspace domain works too') : undefined} t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
            <KeyField endpoint={endpoint} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
            <ImageModelField value={value} keys={keys} t={t} onModels={setListed} onChange={(model) => { onChange(without(value, 'model', model)) }} />
          </>
        ) : null}
        {source === 'custom' ? (
          <>
            <label className="nv-check">
              <input type="checkbox" checked={own} onChange={(event) => { setOwn(event.target.checked) }} />
              <span>{t('我自己的服务器（本机 / 局域网）：一次画一张', 'A server of my own (this machine or network): one picture at a time')}</span>
            </label>
            <SizeListField value={value.sizes} placeholder={own ? (limits !== undefined ? t(`留空：照服务器说的，最大 ${limits.maxWidth}×${limits.maxHeight}`, `Empty: as the server says, up to ${limits.maxWidth}×${limits.maxHeight}`) : LOCAL_SIZES.join(', ')) : t('留空：要多大给多大', 'Empty: whatever size is wanted')} onChange={(sizes) => { onChange(without(value, 'sizes', sizes)) }} t={t} />
          </>
        ) : null}
        {value.provider !== 'none' ? <PictureSizeFields value={value} onChange={onChange} t={t} advanced={advanced} {...(limits !== undefined ? { limits } : {})} /> : null}
        {value.provider !== 'none' && (own || advanced || value.promptTokens !== undefined) ? (
          <Field label={t('提示词上限（token）', 'Prompt limit (tokens)')} hint={t('超过时，画之前由导演重写成放得下的一段', 'A longer prompt is rewritten by the director to fit before the picture is drawn')}>
            <TextInput inputMode="numeric" value={value.promptTokens !== undefined ? String(value.promptTokens) : ''} placeholder={limits?.promptTokens !== undefined ? t(`留空：照服务器说的 ${limits.promptTokens}`, `Empty: the server's own ${limits.promptTokens}`) : t('留空：不限', 'Empty: none')} onChange={(event) => { const count = number(event.target.value); const { promptTokens: _old, ...rest } = value; onChange(count !== undefined && count > 0 ? { ...rest, promptTokens: Math.round(count) } : rest) }} />
          </Field>
        ) : null}
        {value.provider !== 'none' ? (
          <Field label={t('提示词谁来写', 'Who writes the prompt')} hint={t('工坊先把每张图排成同一种分段；导演可以再把它写成一段给模型的话', 'The Studio lays every picture out under the same headings; the director can then write that out for the model')}>
            <Select<PromptWrite> value={promptWriteOf(value)} options={[
              { value: 'fit', label: t('放不下时由导演压缩', 'The director, where it does not fit the model') },
              { value: 'always', label: t('每张都由导演写成一段', 'The director, every time') },
              { value: 'never', label: t('照工坊排好的原样发', 'As the Studio laid it out') },
            ]} onChange={(mode) => { const { promptCompact: _old, promptWrite: _was, ...rest } = value; onChange(mode === 'fit' ? rest : { ...rest, promptWrite: mode }) }} />
          </Field>
        ) : null}
        {value.provider !== 'none' && (own || advanced || value.promptLang !== undefined) ? (
          <Field label={t('提示词语言', 'Prompt language')} hint={t('只懂英文的模型选 English：导演写提示词时全文用英文', 'English for a model that reads nothing else: the director then writes the whole prompt in English')}>
            <Select<'book' | 'en'> value={value.promptLang === 'en' ? 'en' : 'book'} options={[
              { value: 'book', label: t('跟这本书', 'The book\'s') },
              { value: 'en', label: 'English' },
            ]} onChange={(to) => { const { promptLang: _old, ...rest } = value; onChange(to === 'en' ? { ...rest, promptLang: 'en' } : rest) }} />
          </Field>
        ) : null}
        {value.provider !== 'none' && advanced ? (
          <Field label={t('一张图带几张参考图', 'Reference pictures per image')} hint={t(`每张图最多带几张参考图。留空：${REFERENCES_DEFAULT}，最多 ${REFERENCES_MAX}。`, `How many reference pictures one picture may carry. Empty: ${REFERENCES_DEFAULT}; ${REFERENCES_MAX} at most.`)}>
            <TextInput inputMode="numeric" value={value.references !== undefined ? String(value.references) : ''} placeholder={String(REFERENCES_DEFAULT)} onChange={(event) => { const count = number(event.target.value); const { references: _old, ...rest } = value; onChange(count !== undefined && count >= 0 ? { ...rest, references: Math.min(REFERENCES_MAX, Math.round(count)) } : rest) }} />
          </Field>
        ) : null}
        {all && value.provider !== 'none' ? (
          // Shown outright, not only among the fine print: it decides how many pictures a click draws.
          <Field label={t('人物的图以哪张为准', 'Which picture of a person leads')} hint={leadOf(value) === 'portrait'
            ? t('立绘只照文字画；人设图照着立绘画，没有的画完立绘就补；别的图照着人设图画。', 'A portrait is drawn from the words alone; the sheet is drawn against it — after it, where there is none — and other pictures against the sheet.')
            : leadOf(value) === 'none'
              ? t('不为了一张图先去画另一张；已有的人设图照旧带上。', 'Nothing is drawn for another picture\'s sake; a sheet that exists still goes along.')
              : t('人设图只照文字画；立绘和别的图照着它画，没有的先补。', 'The sheet is drawn from the words alone; a portrait and every other picture is drawn against it, and whoever has none gets it first.')}>
            <Select<PictureLead> value={leadOf(value)} options={[
              { value: 'sheet', label: t('人设图为准：先人设图，再照着它画立绘', 'The design sheet: sheet first, the portrait against it') },
              { value: 'portrait', label: t('立绘为准：先立绘，再照着它补人设图', 'The portrait: portrait first, the sheet against it') },
              { value: 'none', label: t('各画各的：不自动补', 'Neither: nothing is drawn first') },
            ]} onChange={(lead) => { const { sheetFirst: _old, lead: _lead, ...rest } = value; onChange(lead === 'sheet' ? rest : { ...rest, lead }) }} />
          </Field>
        ) : null}
        {all && value.provider !== 'none' ? (
          <Field label={t('人设图画什么', 'What a design sheet shows')} hint={t('小的绘图模型画不好并排的三个视图时，选只画正面', 'Where a small image model cannot keep three views alike: the front alone')}>
            <Select<'turn' | 'front'> value={value.sheet === 'front' ? 'front' : 'turn'} options={[
              { value: 'turn', label: t('三视图：正面、侧面、背面', 'Three views: front, side, back') },
              { value: 'front', label: t('只画正面一个人', 'The front view alone') },
            ]} onChange={(sheet) => { const { sheet: _old, ...rest } = value; onChange(sheet === 'front' ? { ...rest, sheet } : rest) }} />
          </Field>
        ) : null}
        {all && value.provider !== 'none' ? (
          <Field label={t('立绘画什么', 'What a portrait comes to')} hint={t('没另说画哪一张时', 'Where nothing else is said of it')}>
            <Select<PortraitPlan> value={portraitsOf(value)} options={PORTRAIT_PLANS.map(plan => ({ value: plan, label: portraitPlanWord(plan, t) }))} onChange={(plan) => { const { portraitScene: _old, portraits: _was, ...rest } = value; onChange(plan === 'both' ? rest : { ...rest, portraits: plan }) }} />
          </Field>
        ) : null}
        {all && value.provider !== 'none' ? (
          <Field label={t('有参考图的人物', 'People whose picture goes along')} hint={t('提示词里还写不写他平常的样子', 'Whether their standing look is written out in the prompt as well')}>
            <Select<'pictured' | 'always'> value={value.looks ?? 'pictured'} options={[{ value: 'pictured', label: looksWord('pictured', t) }, { value: 'always', label: looksWord('always', t) }]} onChange={(looks) => { const { looks: _old, ...rest } = value; onChange(looks === 'always' ? { ...rest, looks } : rest) }} />
          </Field>
        ) : null}
        {all && value.provider !== 'none' ? (
          <label className="nv-check">
            <input type="checkbox" checked={value.panelThings !== false} onChange={(event) => { const { panelThings: _old, ...rest } = value; onChange(event.target.checked ? rest : { ...rest, panelThings: false }) }} />
            <span>{t('有声漫的画面带上物品的设定图', 'A motion comic\'s panels take the art of the things they show along')}</span>
          </label>
        ) : null}
        {(value.provider === 'openai' || value.provider === 'openrouter') && !own ? (
          <Field label={t('质量', 'Quality')}>
            <Select value={value.quality ?? ''} options={[{ value: '', label: t('模型默认', 'Model default') }, { value: 'low', label: t('低（快、省）', 'Low (fast, cheap)') }, { value: 'medium', label: t('中', 'Medium') }, { value: 'high', label: t('高', 'High') }]} onChange={(quality) => { onChange(without(value, 'quality', quality !== '' ? quality : undefined)) }} />
          </Field>
        ) : null}
      </div>
      {all && value.provider !== 'none' ? (
        <div className="nv-note">
          <p>{t('画风属于每一本书，在那本书的“设定 → 画风”里。', 'Art direction belongs to each book: under its Bible → Art.')}</p>
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
  const endpoint = speechEndpoint(value)
  const fallback = value.defaultVoices ?? {}
  const setFallback = (key: 'female' | 'male' | 'neutral', voice: string): void => {
    const { [key]: _old, ...rest } = fallback
    const next = voice.trim().length > 0 ? { ...rest, [key]: voice.trim() } : rest
    onChange(without(value, 'defaultVoices', Object.keys(next).length > 0 ? next : undefined))
  }
  const suggestions = speechSuggestions(value.provider)
  // Voices the endpoint lists for the chosen model win over the stock catalog of the saved provider.
  const fromEndpoint = listed.find(model => model.id === value.model)?.voices ?? []
  const voiceOptions = fromEndpoint.length > 0 ? fromEndpoint.map(voice => ({ id: voice, note: '' })) : value.provider === savedProvider ? voices : []
  return (
    <>
      <div className="nv-form-grid">
        <Field label={t('服务', 'Service')}>
          <Select<TtsProviderKind> value={value.provider} options={TTS_OPTIONS.map(option => ({ value: option.value, label: value.kept?.[option.value] !== undefined && option.value !== value.provider ? t(`${option.label[0]} · 配过，换回去还在`, `${option.label[1]} · set up before, kept`) : t(...option.label) }))} onChange={(provider) => {
            // The service left is remembered as it was set up; the one come back to returns as it was left.
            if (provider === value.provider) return
            const start = ttsDefaults(provider, value)
            onChange(switchTts(value, provider, Object.fromEntries(Object.entries(start).filter(([key]) => (TTS_SERVICE_KEYS as readonly string[]).includes(key)))))
          }} />
        </Field>
        {value.provider !== 'none' ? (
          <>
            <EndpointField value={value.baseURL ?? ''} placeholder={endpoint} hint={value.provider === 'qwen-realtime' ? 'wss://…/api-ws/v1/realtime' : value.provider === 'qwen-audiogen' || value.provider === 'dashscope' ? t('百炼的域名；专属域名也可以', 'The Bailian domain; a workspace domain works too') : undefined} t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
            <KeyField endpoint={endpoint} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
            <ModelField
              label={t('模型', 'Model')}
              hint={serviceOf(endpoint) === 'bailian' ? t('可选百炼上所有语音模型', 'Any speech model on Bailian can be chosen') : undefined}
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
            <Field label={t('并发数', 'Parallel requests')} hint={t(`默认 ${PARALLEL_DEFAULT}，最多 ${PARALLEL_MAX}`, `${PARALLEL_DEFAULT} by default, ${PARALLEL_MAX} at most`)}><TextInput inputMode="numeric" value={value.concurrency !== undefined ? String(value.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { onChange(without(value, 'concurrency', parallel(event.target.value))) }} /></Field>
            <Field label={t('不合格时最多重念', 'Retakes when a line fails the check')} hint={t('没念完、没声音或不像这个角色时重念几次。填 0 不重念。', 'How many times a line is read again when cut short, silent or unlike the voice. 0: never.')}>
              <TextInput inputMode="numeric" value={value.retakes !== undefined ? String(value.retakes) : ''} placeholder="2" onChange={(event) => { const count = number(event.target.value); onChange(without(value, 'retakes', count !== undefined ? Math.max(0, Math.min(4, Math.round(count))) : undefined)) }} />
            </Field>
            <Field label={t('对白之间的"他说"', 'The "he said" between spoken lines')} hint={t('“某某说”这类提示语念不念。脚本里可以逐行改。', 'Whether "he said" tags are read aloud. Each line can be set in the script.')}>
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
          {inWords ? <p className="nv-note">{t('这个模型没有固定音色表：声音由人物卡上的“声音”描述决定。', 'This model has no fixed voices: a voice comes from the description on the character\'s card.')}</p> : null}
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
        <Field label={t('环境底声', 'Ambience beds')} hint={t('没生成之前先用浏览器合成的顶上。', 'Until generated, the browser\'s own synthesis stands in.')}>
          <Select<'generate' | 'browser'> value={value.beds ?? 'generate'} options={[{ value: 'generate', label: t('模型生成（推荐）', 'Generated by the model (recommended)') }, { value: 'browser', label: t('只用浏览器合成', 'Browser-synthesized only') }]} onChange={(beds) => { onChange(without(value, 'beds', beds === 'generate' ? undefined : beds)) }} />
        </Field>
      </div>
      <div className="nv-row-wrap">
        <label className="nv-check"><input type="checkbox" checked={value.effects !== false} onChange={(event) => { onChange(without(value, 'effects', event.target.checked ? undefined : false)) }} /><span>{t('让导演安排音效', 'Have the director place sound effects')}</span></label>
        <label className="nv-check"><input type="checkbox" checked={value.music !== false} onChange={(event) => { onChange(without(value, 'music', event.target.checked ? undefined : false)) }} /><span>{t('让导演安排配乐', 'Have the director place music')}</span></label>
      </div>
      {value.provider === 'none'
        ? <p className="nv-note">{t('不生成声音：只作为正文旁的注释。', 'No sound is generated: it shows only as notes beside the text.')}</p>
        : follows && !canFollow
          ? <p className="nv-note is-warn">{t('现在的语音服务不能生成声音。把上面改成“百炼音频生成”并填密钥。', 'The speech service in use cannot generate sound. Set the above to Bailian audio generation and add its key.')}</p>
          : <p className="nv-note">{ready ? t('已就绪。', 'Ready.') : t('还缺密钥：保存语音那一栏的密钥后这里就能用。', 'A key is still missing: once the speech section has its key this is ready.')}</p>}
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

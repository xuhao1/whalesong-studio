// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures from models on the author's own machine — for trying a local model
 * against a book before, or instead of, paying a service.
 *
 *   ComfyUI     a running ComfyUI server, over its HTTP API: a workflow graph is
 *               queued, waited for, and its picture fetched. The graph is the
 *               author's own (exported in API format, with placeholders the
 *               Studio fills in) — or, for a plain checkpoint, a small one built
 *               here.
 *   Diffusers   the Diffusers library in the author's own Python: a worker is
 *               started with the model named, keeps it loaded between pictures,
 *               and is spoken to over its standard streams.
 *
 * Neither holds a key. Both say what went to the model word for word, like
 * every other provider, and how many reference pictures really went along.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComfyCatalog, IllustrationSent, ImageSettings } from '../../shared/types'
import { ProviderError, trimBase } from './http'
import type { ImageProvider, ImageReference, ImageRequest, ImageResult } from './image'

export const COMFY_DEFAULT = 'http://127.0.0.1:8188'
/** The key a workflow kept in the settings says under where it was taken from. */
export const WORKFLOW_NOTE = '_novel'

/** `WIDTHxHEIGHT` in pixels a latent model can make: each side a multiple of 16. */
function sides(size: string | undefined): { width: number; height: number } {
  const found = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(size?.trim() ?? '')
  const round = (value: number): number => Math.max(256, Math.round(value / 16) * 16)
  return found !== null ? { width: round(Number(found[1])), height: round(Number(found[2])) } : { width: 1024, height: 1024 }
}

const newSeed = (): number => Math.floor(Math.random() * 0xffffffff)

function extensionOf(mime: string): string {
  return mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
}

function mimeOf(name: string, header: string | null): string {
  if (header !== null && header.startsWith('image/')) return header.split(';')[0]!
  return /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png'
}

// ───────────────────────────── ComfyUI ─────────────────────────────

type Graph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>

/** The values a workflow's placeholders stand for. A string that is exactly one placeholder takes the value with its type. */
export function fillWorkflow(graph: unknown, values: Record<string, string | number>): unknown {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^%([a-z_0-9]+)%$/.exec(value)
      if (whole !== null && whole[1]! in values) return values[whole[1]!]
      return value.replace(/%([a-z_0-9]+)%/g, (kept, name: string) => (name in values ? String(values[name]) : kept))
    }
    if (Array.isArray(value)) return value.map(fill)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]))
    return value
  }
  return fill(graph)
}

/** How many reference pictures a workflow has a place for (`%image1%`, `%image2%`, …). */
export function workflowImages(graph: unknown): number {
  const found = JSON.stringify(graph).match(/%image(\d+)%/g) ?? []
  return found.reduce((most, name) => Math.max(most, Number(/\d+/.exec(name)![0])), 0)
}

/** The graph for a plain checkpoint: text in, one picture out. */
function checkpointGraph(model: string, sampler = 'euler', scheduler = 'normal'): Graph {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: '%steps%', cfg: '%scale%', sampler_name: sampler, scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'novel-studio', images: ['8', 0] } },
  }
}

/**
 * The graph for a diffusion model that comes alone — the server's `diffusion_models` —, loaded beside a text encoder
 * and a VAE: text in, one picture out.
 */
function partsGraph(model: string, encoder: string, type: string, vae: string, sampler = 'euler', scheduler = 'simple'): Graph {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: model, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: encoder, type } },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['2', 0] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['2', 0] } },
    4: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: '%steps%', cfg: '%scale%', sampler_name: sampler, scheduler, denoise: 1, model: ['1', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'novel-studio', images: ['8', 0] } },
  }
}

const trimmedBase = (baseURL: string | undefined): string => trimBase(baseURL?.trim() || COMFY_DEFAULT)

/** Guidance where nothing says otherwise: what a classic checkpoint is sampled with — and a diffusion model that comes alone, which is of the newer kind and burns at that. */
const GUIDANCE = { checkpoint: 7, alone: 3.5 }

/**
 * How the server itself last sampled with a model: the steps, the guidance, the sampler and the scheduler of its
 * latest run that loaded it and made a picture. A model is drawn well at the figures it was made for, and those
 * differ from one to the next by more than a default can cover — guidance 7 suits a Stable Diffusion checkpoint
 * and leaves a newer model's picture harsh and flat. Whoever runs the server found them already.
 */
export async function comfySampling(baseURL: string | undefined, model: string, signal?: AbortSignal): Promise<{ steps?: number; cfg?: number; sampler?: string; scheduler?: string } | undefined> {
  const answered = await fetch(`${trimmedBase(baseURL)}/history?max_items=48`, { signal: signal ?? AbortSignal.timeout(15_000) }).catch(() => undefined)
  if (answered === undefined || !answered.ok) return undefined
  type Run = { prompt?: [number, string, unknown, ...unknown[]]; outputs?: Record<string, { images?: unknown[] }>; status?: { status_str?: string } }
  const runs = Object.values(await answered.json().catch(() => ({})) as Record<string, Run>)
    .filter(run => run.status?.status_str !== 'error' && Object.values(run.outputs ?? {}).some(output => (output.images?.length ?? 0) > 0))
    .sort((left, right) => (right.prompt?.[0] ?? 0) - (left.prompt?.[0] ?? 0))
  // The author's own runs before the Studio's: its own say only what it guessed.
  const own = (graph: Graph): boolean => Object.values(graph).some(node => node.class_type === 'SaveImage' && node.inputs?.filename_prefix === 'novel-studio')
  const graphs = runs.map(run => run.prompt?.[2]).filter((graph): graph is Graph => graph !== null && typeof graph === 'object')
  for (const graph of [...graphs.filter(graph => !own(graph)), ...graphs.filter(own)]) {
    if (!Object.values(graph).some(node => Object.values(node.inputs ?? {}).includes(model))) continue
    const sampler = Object.values(graph).find(node => Array.isArray(node.inputs?.positive) && Array.isArray(node.inputs?.negative))
    if (sampler?.inputs === undefined) continue
    const { steps, cfg, sampler_name: name, scheduler } = sampler.inputs
    return { ...(typeof steps === 'number' ? { steps } : {}), ...(typeof cfg === 'number' ? { cfg } : {}), ...(typeof name === 'string' ? { sampler: name } : {}), ...(typeof scheduler === 'string' ? { scheduler } : {}) }
  }
  return undefined
}

/** What one of a loader node's inputs can be set to, as the server lists it: the files it has, or the kinds it knows. */
async function loaderChoices(base: string, node: string, input: string, signal: AbortSignal | undefined): Promise<string[]> {
  const answered = await fetch(`${base}/object_info/${node}`, { signal: signal ?? AbortSignal.timeout(15_000) })
  if (!answered.ok) return []
  const info = await answered.json().catch(() => ({})) as Record<string, { input?: Record<string, Record<string, unknown>> }>
  const spec = info[node]?.input?.required?.[input] ?? info[node]?.input?.optional?.[input]
  // The old shape: [[choices], {…}]. The new one: ["COMBO", { options: [choices] }].
  const first = Array.isArray(spec) ? spec[0] : undefined
  const listed = Array.isArray(first) ? first : (Array.isArray(spec) ? (spec[1] as { options?: unknown } | undefined)?.options : undefined)
  return Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string') : []
}

/** A file of weights, as against the stand-ins a loader lists beside them (`taesd`, `pixel_space`). */
const isFile = (name: string): boolean => /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i.test(name)

/**
 * A run the server made, turned into a workflow the Studio can fill in: the words it was given become `%prompt%` and
 * `%negative_prompt%`, the size of its empty latent `%width%` and `%height%`, its seed `%seed%`. Everything else — the
 * models it loads, the sampler, the steps — stays as the server ran it: those are what made the run work.
 * @returns undefined for a graph that has no sampler fed by a text the Studio could replace.
 */
export function workflowTemplate(run: unknown): { workflow: Graph; model?: string; nodes: string[]; images: number } | undefined {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return undefined
  const graph = JSON.parse(JSON.stringify(run)) as Graph
  const linked = (node: Graph[string] | undefined, input: string): string | undefined => {
    const value = node?.inputs?.[input]
    return Array.isArray(value) && (typeof value[0] === 'string' || typeof value[0] === 'number') ? String(value[0]) : undefined
  }
  const sampler = Object.values(graph).find(node => linked(node, 'positive') !== undefined && linked(node, 'negative') !== undefined)
  if (sampler === undefined) return undefined
  const NOT_WORDS = /name|sampler|scheduler|type|device|dtype|prefix|mode|method|format|upscale|crop/i
  const words = (node: Graph[string] | undefined, negative: boolean): string | undefined => {
    const keys = Object.entries(node?.inputs ?? {}).filter(([key, value]) => typeof value === 'string' && !NOT_WORDS.test(key)).map(([key]) => key)
    if (negative) return keys.find(key => /neg/i.test(key))
    return keys.find(key => /^(prompt|text|positive|caption)$/i.test(key)) ?? keys.find(key => !/neg|system/i.test(key))
  }
  // The text a conditioning comes from: the node itself, or one a few steps up (a guidance or a combine in between).
  const source = (id: string | undefined, negative: boolean): { node: Graph[string]; key: string } | undefined => {
    let at = id
    for (let hop = 0; hop < 4 && at !== undefined; hop += 1) {
      const node = graph[at]
      const key = words(node, negative)
      if (node !== undefined && key !== undefined) return { node, key }
      at = linked(node, 'conditioning') ?? linked(node, 'positive') ?? linked(node, 'conditioning_1')
    }
    return undefined
  }
  const positiveId = linked(sampler, 'positive')
  const negativeId = linked(sampler, 'negative')
  const positive = source(positiveId, false)
  if (positive === undefined) return undefined
  // One node may encode both (its negative under a name of its own); else the negative side has a node of its own.
  const negative = words(positive.node, true) !== undefined ? { node: positive.node, key: words(positive.node, true)! }
    : negativeId !== positiveId ? (() => {
        const node = negativeId !== undefined ? graph[negativeId] : undefined
        const key = words(node, true) ?? words(node, false)
        return node !== undefined && key !== undefined ? { node, key } : undefined
      })() : undefined
  positive.node.inputs![positive.key] = '%prompt%'
  if (negative !== undefined && !(negative.node === positive.node && negative.key === positive.key)) negative.node.inputs![negative.key] = '%negative_prompt%'
  const latent = graph[linked(sampler, 'latent_image') ?? linked(sampler, 'latent') ?? '']
  if (typeof latent?.inputs?.width === 'number' && typeof latent.inputs.height === 'number') {
    latent.inputs.width = '%width%'
    latent.inputs.height = '%height%'
  }
  for (const key of ['seed', 'noise_seed']) if (typeof sampler.inputs?.[key] === 'number') sampler.inputs[key] = '%seed%'
  for (const node of Object.values(graph)) if (node.class_type === 'SaveImage' && node.inputs !== undefined) node.inputs.filename_prefix = 'novel-studio'
  // The pictures it loads are the reference pictures' places: the first by the input it feeds (image_1 before image_2), then by its number.
  const feeds = (id: string): string => {
    for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs ?? {})) if (Array.isArray(value) && String(value[0]) === id) return key
    return ''
  }
  const loaded = Object.entries(graph).filter(([, node]) => node.class_type === 'LoadImage' && typeof node.inputs?.image === 'string')
    .sort(([left], [right]) => feeds(left).localeCompare(feeds(right), undefined, { numeric: true }) || Number(left) - Number(right))
  loaded.forEach(([, node], at) => { node.inputs!.image = `%image${at + 1}%` })
  const loaders = Object.values(graph)
  const named = (type: string, input: string): string | undefined => {
    const value = loaders.find(node => node.class_type === type)?.inputs?.[input]
    return typeof value === 'string' ? value : undefined
  }
  const model = named('UNETLoader', 'unet_name') ?? named('CheckpointLoaderSimple', 'ckpt_name') ?? named('CheckpointLoader', 'ckpt_name') ?? named('UnetLoaderGGUF', 'unet_name')
  return { workflow: graph, ...(model !== undefined ? { model } : {}), nodes: Object.values(graph).map(node => node.class_type ?? '?'), images: loaded.length }
}

/** What the server says of one kind of node: its inputs in order, and whether running it leaves something. */
interface NodeInfo {
  input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
  input_order?: { required?: string[]; optional?: string[] }
  output_node?: boolean
}

/**
 * A workflow as ComfyUI's editor saves it, turned into the graph its server runs. The editor keeps what a node's
 * widgets are set to as a list without names, beside buttons and notes the server knows nothing of; the server wants
 * every input by name. What each kind of node takes is asked of the server (`info`).
 * @throws ProviderError for what cannot be told from the file: a workflow with subgraphs, or a node switched to bypass.
 */
export function editorToApi(saved: unknown, info: Record<string, NodeInfo | undefined>): Graph {
  const file = saved as { nodes?: unknown[]; links?: unknown[]; definitions?: { subgraphs?: unknown[] } }
  if (!Array.isArray(file.nodes)) throw new ProviderError('this is not a workflow as ComfyUI saves it')
  if ((file.definitions?.subgraphs?.length ?? 0) > 0) throw new ProviderError('this workflow has subgraphs, which cannot be told from the saved file: export it in API format (Workflow → Export (API)) and name that file')
  type Node = { id: number | string; type?: string; mode?: number; inputs?: { name?: string; link?: number | null; widget?: unknown; type?: string }[]; widgets_values?: unknown }
  const nodes = new Map((file.nodes as Node[]).map(node => [String(node.id), node]))
  // A link: [id, from node, from slot, to node, to slot, type] — or the same as an object.
  const links = new Map<number, { from: string; slot: number }>()
  for (const raw of file.links ?? []) {
    if (Array.isArray(raw)) links.set(Number(raw[0]), { from: String(raw[1]), slot: Number(raw[2]) })
    else if (raw !== null && typeof raw === 'object') {
      const link = raw as { id?: number; origin_id?: number | string; origin_slot?: number }
      if (link.id !== undefined && link.origin_id !== undefined) links.set(link.id, { from: String(link.origin_id), slot: link.origin_slot ?? 0 })
    }
  }
  const CONTROL = new Set(['fixed', 'increment', 'decrement', 'randomize'])
  const isWidget = (spec: unknown): boolean => {
    const type = Array.isArray(spec) ? spec[0] : undefined
    return Array.isArray(type) || type === 'COMBO' || type === 'INT' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN'
  }
  const optionsOf = (spec: unknown): Record<string, unknown> => (Array.isArray(spec) && spec[1] !== null && typeof spec[1] === 'object' ? spec[1] as Record<string, unknown> : {})
  /** What comes out of a link: another node's output, or — through the editor's own helper nodes — a plain value. */
  const through = (id: number | null | undefined, depth = 0): [string, number] | { value: unknown } | undefined => {
    const link = id !== null && id !== undefined ? links.get(id) : undefined
    const from = link !== undefined ? nodes.get(link.from) : undefined
    if (link === undefined || from === undefined || depth > 16) return undefined
    if (from.type === 'Reroute') return through(from.inputs?.[0]?.link, depth + 1)
    if (from.type === 'PrimitiveNode') return { value: Array.isArray(from.widgets_values) ? from.widgets_values[0] : undefined }
    if (from.mode === 4) throw new ProviderError(`this workflow has a node switched to bypass (${from.type ?? '?'}), which cannot be told from the saved file: switch it back on or take it out, or export the workflow in API format`)
    if (from.mode === 2 || info[from.type ?? ''] === undefined) return undefined
    return [link.from, link.slot]
  }
  const graph: Graph = {}
  for (const [id, node] of nodes) {
    const about = node.type !== undefined ? info[node.type] : undefined
    // Notes and the editor's helpers are no nodes of the server's; a muted node does not run.
    if (about === undefined || node.mode === 2 || node.mode === 4) continue
    const specs: Record<string, unknown> = { ...(about.input?.required ?? {}), ...(about.input?.optional ?? {}) }
    const order = [...(about.input_order?.required ?? Object.keys(about.input?.required ?? {})), ...(about.input_order?.optional ?? Object.keys(about.input?.optional ?? {}))]
    const listed = node.inputs ?? []
    // The widgets in the order the editor keeps their values: named by the file where it names them, else as the server orders them.
    const flagged = listed.filter(input => input.widget !== undefined && input.widget !== null && input.name !== undefined).map(input => input.name!)
    const widgets = flagged.length > 0 ? flagged : order.filter(name => isWidget(specs[name]))
    const inputs: Record<string, unknown> = {}
    const values = node.widgets_values
    if (Array.isArray(values)) {
      let at = 0
      for (const name of widgets) {
        if (at >= values.length) break
        const value = values[at++]
        if (name in specs) inputs[name] = value
        // Beside a seed the editor keeps what to do with it after a run; beside a picture, its upload button.
        if ((optionsOf(specs[name]).control_after_generate === true || /^(noise_)?seed$/.test(name)) && typeof values[at] === 'string' && CONTROL.has(values[at] as string)) at += 1
        if (flagged.length === 0 && optionsOf(specs[name]).image_upload === true && values[at] === 'image') at += 1
      }
    } else if (values !== null && typeof values === 'object') {
      for (const [name, value] of Object.entries(values as Record<string, unknown>)) if (name in specs) inputs[name] = value
    }
    for (const input of listed) {
      if (input.name === undefined || input.link === null || input.link === undefined) continue
      // An input of a group that grows ("images.image_1") is the server's by the group's name.
      if (!(input.name in specs) && !(input.name.split('.')[0]! in specs) && Object.keys(specs).length > 0) continue
      const from = through(input.link)
      if (from === undefined) continue
      inputs[input.name] = Array.isArray(from) ? from : from.value
    }
    graph[id] = { class_type: node.type!, inputs }
  }
  // Only what leads to something kept: a picture loader left unconnected would be checked by the server for a file it has no use for.
  const ends = Object.entries(graph).filter(([, node]) => info[node.class_type ?? '']?.output_node === true).map(([id]) => id)
  if (ends.length === 0) return graph
  const wanted = new Set<string>()
  const walk = (id: string): void => {
    if (wanted.has(id) || graph[id] === undefined) return
    wanted.add(id)
    for (const value of Object.values(graph[id]!.inputs ?? {})) if (Array.isArray(value) && typeof value[0] === 'string') walk(value[0])
  }
  ends.forEach(walk)
  return Object.fromEntries(Object.entries(graph).filter(([id]) => wanted.has(id)))
}

/** The workflows saved on a ComfyUI server, by their path under its workflows folder. */
export async function comfyWorkflows(baseURL: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const base = trimmedBase(baseURL)
  const answered = await fetch(`${base}/userdata?dir=workflows&recurse=true&split=false&full_info=true`, { signal: signal ?? AbortSignal.timeout(15_000) }).catch(() => undefined)
  if (answered === undefined || !answered.ok) return []
  const listed = await answered.json().catch(() => []) as unknown
  return (Array.isArray(listed) ? listed : [])
    .map(item => (typeof item === 'string' ? item : (item as { path?: string } | null)?.path))
    .filter((path): path is string => typeof path === 'string' && path.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Take a workflow saved on the server — as its editor saves it — as a workflow the Studio fills in: turned into the
 * graph the server runs, with the words, the size and the seed as placeholders and the pictures it loads as the
 * reference pictures' places.
 * @throws ProviderError naming what stands in the way: no such file, a file that is no workflow, a graph with no sampler fed by a text.
 */
export async function comfyTakeWorkflow(baseURL: string | undefined, path: string, signal?: AbortSignal): Promise<{ workflow: Graph; model?: string; nodes: string[]; images: number }> {
  const base = trimmedBase(baseURL)
  const ask = async (url: string): Promise<Response> => {
    try {
      return await fetch(url, { signal: signal ?? AbortSignal.timeout(20_000) })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new ProviderError(`ComfyUI at ${base} did not answer (${error instanceof Error ? error.message : String(error)}) — is it running?`)
    }
  }
  const fetched = await ask(`${base}/userdata/${encodeURIComponent(`workflows/${path}`)}`)
  if (!fetched.ok) throw new ProviderError(`ComfyUI has no saved workflow "${path}" (${fetched.status})`, fetched.status)
  const saved = await fetched.json().catch(() => undefined) as unknown
  let graph: unknown = saved
  // As the editor saves it: turned into what the server runs, with what the server says each of its nodes takes.
  if (saved !== null && typeof saved === 'object' && Array.isArray((saved as { nodes?: unknown }).nodes)) {
    const types = [...new Set(((saved as { nodes: { type?: string }[] }).nodes).map(node => node.type).filter((type): type is string => typeof type === 'string'))]
    const info: Record<string, NodeInfo | undefined> = {}
    await Promise.all(types.map(async (type) => {
      const answered = await ask(`${base}/object_info/${encodeURIComponent(type)}`)
      const body = answered.ok ? await answered.json().catch(() => ({})) as Record<string, NodeInfo> : {}
      if (body[type] !== undefined) info[type] = body[type]
    }))
    graph = editorToApi(saved, info)
  }
  const made = workflowTemplate(graph)
  if (made === undefined) throw new ProviderError(`the workflow "${path}" has no sampler fed by a text the Studio could fill in: it is not one that draws a picture from a prompt`)
  return made
}

/** The last run in the server's history that made a picture, as a workflow to fill in. The history is the server's memory only: it is gone when the server restarts. */
export async function comfyLastWorkflow(baseURL: string | undefined, signal?: AbortSignal): Promise<{ workflow: Graph; model?: string; nodes: string[]; images: number } | undefined> {
  const base = trimmedBase(baseURL)
  const answered = await fetch(`${base}/history?max_items=24`, { signal: signal ?? AbortSignal.timeout(15_000) }).catch(() => undefined)
  if (answered === undefined || !answered.ok) return undefined
  type Run = { prompt?: [number, string, unknown, ...unknown[]]; outputs?: Record<string, { images?: unknown[] }>; status?: { status_str?: string } }
  const runs = Object.values(await answered.json().catch(() => ({})) as Record<string, Run>)
    .filter(run => run.status?.status_str !== 'error' && Object.values(run.outputs ?? {}).some(output => (output.images?.length ?? 0) > 0))
    .sort((left, right) => (right.prompt?.[0] ?? 0) - (left.prompt?.[0] ?? 0))
  // The author's own runs first: what the Studio queued itself (it saves under its own name) says nothing new.
  const own = (run: Run): boolean => Object.values((run.prompt?.[2] ?? {}) as Graph).some(node => node.class_type === 'SaveImage' && node.inputs?.filename_prefix === 'novel-studio')
  for (const run of [...runs.filter(run => !own(run)), ...runs.filter(own)]) {
    const made = workflowTemplate(run.prompt?.[2])
    if (made !== undefined) return made
  }
  return undefined
}

/**
 * Ask a ComfyUI server what it has to draw with: the models its loaders list, the device it runs on, and the last run
 * that made a picture.
 * @throws ProviderError when nothing answers at the address.
 */
export async function comfyCatalog(baseURL: string | undefined, signal?: AbortSignal): Promise<ComfyCatalog> {
  const base = trimmedBase(baseURL)
  let stats: { system?: { comfyui_version?: string }; devices?: { name?: string; vram_total?: number }[] }
  try {
    const answered = await fetch(`${base}/system_stats`, { signal: signal ?? AbortSignal.timeout(10_000) })
    if (!answered.ok) throw new Error(`HTTP ${answered.status}`)
    stats = await answered.json() as typeof stats
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new ProviderError(`ComfyUI at ${base} did not answer (${error instanceof Error ? error.message : String(error)}) — is it running, and reachable from this computer?`)
  }
  const [checkpoints, diffusion, encoders, encoderTypes, vaes, last, workflows] = await Promise.all([
    loaderChoices(base, 'CheckpointLoaderSimple', 'ckpt_name', signal),
    loaderChoices(base, 'UNETLoader', 'unet_name', signal),
    loaderChoices(base, 'CLIPLoader', 'clip_name', signal),
    loaderChoices(base, 'CLIPLoader', 'type', signal),
    loaderChoices(base, 'VAELoader', 'vae_name', signal),
    comfyLastWorkflow(base, signal),
    comfyWorkflows(base, signal),
  ])
  const device = stats.devices?.[0]
  return {
    base,
    ...(stats.system?.comfyui_version !== undefined ? { version: stats.system.comfyui_version } : {}),
    ...(device?.name !== undefined ? { device: `${device.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '')}${device.vram_total !== undefined ? ` · ${Math.round(device.vram_total / 2 ** 30)} GB` : ''}` } : {}),
    checkpoints,
    diffusion,
    encoders,
    vaes: vaes.filter(isFile),
    encoderTypes,
    ...(last !== undefined ? { last: { ...(last.model !== undefined ? { model: last.model } : {}), nodes: last.nodes } } : {}),
    workflows,
  }
}

/** A workflow as the settings name it: the JSON itself, or the path of a file that holds it. */
async function readWorkflow(source: string): Promise<unknown> {
  const text = source.trim().startsWith('{') ? source : await readFile(source.trim().replace(/^~(?=$|[\\/])/, homedir()), 'utf8').catch((error: unknown) => {
    throw new ProviderError(`the ComfyUI workflow file could not be read (${source.trim()}): ${error instanceof Error ? error.message : String(error)}`)
  })
  let graph: unknown
  try {
    graph = JSON.parse(text)
  } catch {
    throw new ProviderError('the ComfyUI workflow is not JSON')
  }
  if (graph !== null && typeof graph === 'object' && Array.isArray((graph as { nodes?: unknown }).nodes)) {
    throw new ProviderError('this ComfyUI workflow is in the editor\'s format, which the server does not run: choose it from the server\'s saved workflows under Settings → Images, or export it in API format (Workflow → Export (API)) and name that file')
  }
  // Where the settings keep a workflow taken from the server, they keep beside it where it came from: no node of the graph.
  if (graph !== null && typeof graph === 'object') delete (graph as Record<string, unknown>)[WORKFLOW_NOTE]
  return graph
}

export class ComfyImages implements ImageProvider {
  readonly kind = 'comfyui' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings) {
    this.model = settings.model?.trim() ?? ''
  }

  private get base(): string {
    return trimBase(this.settings.baseURL?.trim() || COMFY_DEFAULT)
  }

  private async call(path: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { ...init, signal: signal ?? AbortSignal.timeout(30_000) })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new ProviderError(`ComfyUI at ${this.base} did not answer (${error instanceof Error ? error.message : String(error)}) — is it running?`)
    }
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const { width, height } = sides(request.size ?? this.settings.size)
    const references = request.references ?? []
    const negative = request.negativePrompt ?? this.settings.negativePrompt ?? ''
    // With pictures to hold to, the workflow that takes pictures — where the author named one.
    const withImages = references.length > 0 && (this.settings.editWorkflow?.trim().length ?? 0) > 0
    const source = withImages ? this.settings.editWorkflow! : this.settings.workflow
    let graph: unknown
    let model = this.model
    // A graph built here is sampled as the settings say; where they say nothing, as the server last sampled with this model; else at the usual figures for its kind.
    let sampling: NonNullable<IllustrationSent['sampling']> | undefined
    const sampled = async (alone: boolean): Promise<NonNullable<IllustrationSent['sampling']>> => {
      const set = { steps: this.settings.steps, guidance: this.settings.guidance }
      // (The server is asked also where both figures are set: the sampler and the scheduler are the model's as much as they are.)
      const found = await comfySampling(this.base, model, request.signal).catch(() => undefined)
      const took = (set.steps === undefined && found?.steps !== undefined) || (set.guidance === undefined && found?.cfg !== undefined)
      sampling = {
        steps: set.steps ?? found?.steps ?? 25,
        guidance: set.guidance ?? found?.cfg ?? (alone ? GUIDANCE.alone : GUIDANCE.checkpoint),
        sampler: found?.sampler ?? 'euler',
        scheduler: found?.scheduler ?? (alone ? 'simple' : 'normal'),
        from: took ? 'server' : set.steps !== undefined && set.guidance !== undefined ? 'settings' : 'builtin',
      }
      return sampling
    }
    if (source !== undefined && source.trim().length > 0) graph = await readWorkflow(source)
    else {
      // No workflow named: a small graph built here, for what the model named is — a whole checkpoint, or a diffusion
      // model that comes alone and is loaded beside a text encoder and a VAE. Which it is, the server says.
      const choices = async (node: string, input: string): Promise<string[]> => {
        try {
          return await loaderChoices(this.base, node, input, request.signal)
        } catch (error) {
          if (request.signal?.aborted === true) throw error
          throw new ProviderError(`ComfyUI at ${this.base} did not answer (${error instanceof Error ? error.message : String(error)}) — is it running?`)
        }
      }
      const checkpoints = await choices('CheckpointLoaderSimple', 'ckpt_name')
      // No model named: the first checkpoint the server has.
      if (model.length === 0 && checkpoints.length > 0) model = checkpoints[0]!
      if (checkpoints.includes(model)) {
        const how = await sampled(false)
        graph = checkpointGraph(model, how.sampler, how.scheduler)
      } else {
        const diffusion = await choices('UNETLoader', 'unet_name')
        if (model.length === 0 && diffusion.length === 1) model = diffusion[0]!
        if (model.length === 0) {
          throw new ProviderError(diffusion.length > 0
            ? `ComfyUI at ${this.base} has no checkpoint, and ${diffusion.length} diffusion models (${diffusion.slice(0, 4).join(', ')}): choose one under Settings → Images → Model — or use the workflow of the server's last run there`
            : 'ComfyUI has no model to draw with: name one under Model, or name a workflow file')
        }
        if (!diffusion.includes(model)) {
          // Not a name the server lists (or it lists nothing, being older): taken for a checkpoint, as it always was.
          if (diffusion.length > 0 || checkpoints.length > 0) throw new ProviderError(`ComfyUI at ${this.base} has no model "${model}" — it has: ${[...checkpoints, ...diffusion].slice(0, 8).join(', ')}`)
          const how = await sampled(false)
          graph = checkpointGraph(model, how.sampler, how.scheduler)
        } else {
          const [encoders, types, vaes] = await Promise.all([choices('CLIPLoader', 'clip_name'), choices('CLIPLoader', 'type'), choices('VAELoader', 'vae_name').then(list => list.filter(isFile))])
          const encoder = this.settings.textEncoder?.trim() || (encoders.length === 1 ? encoders[0]! : '')
          const vae = this.settings.vae?.trim() || (vaes.length === 1 ? vaes[0]! : '')
          const type = this.settings.encoderType?.trim() || (types.length === 1 ? types[0]! : '')
          const missing = [encoder.length === 0 ? `a text encoder (${encoders.slice(0, 4).join(', ') || 'the server lists none'})` : '', vae.length === 0 ? `a VAE (${vaes.slice(0, 4).join(', ') || 'the server lists none'})` : '', type.length === 0 ? 'the kind the encoder is loaded as' : ''].filter(part => part.length > 0)
          if (missing.length > 0) throw new ProviderError(`"${model}" is a diffusion model that comes alone: it is loaded beside a text encoder and a VAE, and the server leaves a choice — name ${missing.join(', ')} under Settings → Images, or use the workflow of the server's last run there`)
          const how = await sampled(true)
          graph = partsGraph(model, encoder, type, vae, how.sampler, how.scheduler)
        }
      }
    }
    // Reference pictures go up first, as many as the workflow has places for; it names them by the file names it is given back.
    const places = workflowImages(graph)
    const names: string[] = []
    for (const [index, reference] of references.slice(0, places).entries()) {
      const form = new FormData()
      form.set('image', new Blob([reference.data], { type: reference.mime }), `novel-studio-ref-${Date.now().toString(36)}-${index + 1}.${extensionOf(reference.mime)}`)
      form.set('overwrite', 'true')
      const uploaded = await this.call('/upload/image', { method: 'POST', body: form }, request.signal)
      if (!uploaded.ok) throw new ProviderError(`ComfyUI refused a reference picture (${uploaded.status}): ${(await uploaded.text()).slice(0, 200)}`, uploaded.status)
      const kept = await uploaded.json() as { name?: string; subfolder?: string }
      names.push(kept.subfolder !== undefined && kept.subfolder.length > 0 ? `${kept.subfolder}/${kept.name ?? ''}` : kept.name ?? '')
    }
    if (places > 0 && names.length === 0) throw new ProviderError('this ComfyUI workflow takes reference pictures (%image1%) and this picture has none: name it under "Workflow with reference pictures" and keep a plain one under "Workflow"')
    const seed = newSeed()
    const values: Record<string, string | number> = {
      prompt: request.prompt,
      negative_prompt: negative,
      width,
      height,
      seed,
      steps: sampling?.steps ?? this.settings.steps ?? 25,
      scale: sampling?.guidance ?? this.settings.guidance ?? GUIDANCE.checkpoint,
      model,
    }
    // A workflow with more places than there are pictures shows the last one again rather than fail on an empty loader.
    for (let at = 1; at <= places; at += 1) values[`image${at}`] = names[Math.min(at, names.length) - 1]!
    const queued = await this.call('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: fillWorkflow(graph, values), client_id: `novel-studio-${seed.toString(36)}` }) }, request.signal)
    const answer = await queued.json().catch(() => ({})) as { prompt_id?: string; error?: { message?: string } | string; node_errors?: Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }> }
    const nodeErrors = Object.values(answer.node_errors ?? {}).flatMap(node => (node.errors ?? []).map(error => `${node.class_type ?? ''}: ${error.message ?? ''} ${error.details ?? ''}`.trim()))
    if (!queued.ok || answer.prompt_id === undefined) {
      const said = typeof answer.error === 'string' ? answer.error : answer.error?.message
      throw new ProviderError(`ComfyUI did not take the workflow${said !== undefined ? `: ${said}` : ''}${nodeErrors.length > 0 ? ` — ${nodeErrors.slice(0, 3).join('; ')}` : ''}`, queued.status)
    }
    const id = answer.prompt_id
    type Entry = { outputs?: Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[] }>; status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string; node_type?: string }][] } }
    let entry: Entry | undefined
    while (entry === undefined) {
      if (request.signal?.aborted === true) {
        // Stopped by the author: the server is told to stop as well.
        await fetch(`${this.base}/interrupt`, { method: 'POST' }).catch(() => {})
        throw request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted')
      }
      await new Promise(resolve => setTimeout(resolve, 700))
      const history = await this.call(`/history/${id}`, {}, undefined)
      const found = history.ok ? (await history.json() as Record<string, Entry>)[id] : undefined
      if (found !== undefined && (found.status?.completed === true || found.status?.status_str === 'error' || Object.keys(found.outputs ?? {}).length > 0)) entry = found
    }
    if (entry.status?.status_str === 'error') {
      const failed = entry.status.messages?.find(message => message[0] === 'execution_error')?.[1]
      throw new ProviderError(`ComfyUI failed while running the workflow${failed !== undefined ? ` (${failed.node_type ?? 'a node'}): ${failed.exception_message ?? ''}` : ''}`)
    }
    const pictures = Object.values(entry.outputs ?? {}).flatMap(output => output.images ?? [])
    const picture = pictures.find(item => item.type === 'output') ?? pictures[0]
    if (picture?.filename === undefined) throw new ProviderError('the ComfyUI workflow ran and saved no picture: it needs a SaveImage node')
    const fetched = await this.call(`/view?${new URLSearchParams({ filename: picture.filename, subfolder: picture.subfolder ?? '', type: picture.type ?? 'output' }).toString()}`, {}, request.signal)
    if (!fetched.ok) throw new ProviderError(`ComfyUI did not hand over the picture (${fetched.status})`, fetched.status)
    return {
      data: new Uint8Array(await fetched.arrayBuffer()),
      mime: mimeOf(picture.filename, fetched.headers.get('content-type')),
      referencesUsed: names.length,
      sent: { prompt: request.prompt, ...(negative.length > 0 ? { negative } : {}), size: `${width}x${height}`, ...(sampling !== undefined ? { sampling } : {}) },
    }
  }
}

// ───────────────────────────── Diffusers ─────────────────────────────

/**
 * The worker: loads one pipeline, then draws what it is asked, one line of JSON
 * in and one out. It passes a pipeline only what that pipeline's call takes —
 * not every one has a negative prompt, a size, or a picture to start from.
 */
export const DIFFUSERS_WORKER = String.raw`
import sys, json, inspect, traceback

def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

try:
    import torch
    from diffusers import DiffusionPipeline
except Exception as error:
    say({"fatal": "this Python has no diffusers and torch (pip install diffusers transformers accelerate torch): " + str(error)})
    sys.exit(1)

model, device, dtype = sys.argv[1], sys.argv[2], sys.argv[3]
if device == "auto":
    mps = getattr(torch.backends, "mps", None)
    device = "cuda" if torch.cuda.is_available() else "mps" if mps is not None and mps.is_available() else "cpu"
if dtype == "auto":
    dtype = "float16" if device == "cuda" else "float32"
try:
    kind = getattr(torch, dtype)
    if model.lower().endswith((".safetensors", ".ckpt")):
        from diffusers import StableDiffusionXLPipeline, StableDiffusionPipeline
        try:
            pipe = StableDiffusionXLPipeline.from_single_file(model, torch_dtype=kind)
        except Exception:
            pipe = StableDiffusionPipeline.from_single_file(model, torch_dtype=kind)
    else:
        pipe = DiffusionPipeline.from_pretrained(model, torch_dtype=kind)
    pipe = pipe.to(device)
except Exception as error:
    say({"fatal": "could not load " + model + ": " + (str(error) or type(error).__name__)})
    sys.exit(1)

accepts = set(inspect.signature(pipe.__call__).parameters)
say({"ready": True, "device": device, "dtype": dtype, "pipeline": type(pipe).__name__, "negative": "negative_prompt" in accepts, "image": "image" in accepts})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    ask = json.loads(line)
    try:
        args = {"prompt": ask["prompt"]}
        if ask.get("negative") and "negative_prompt" in accepts:
            args["negative_prompt"] = ask["negative"]
        if "width" in accepts and "height" in accepts:
            args["width"] = ask["width"]
            args["height"] = ask["height"]
        if ask.get("steps") and "num_inference_steps" in accepts:
            args["num_inference_steps"] = ask["steps"]
        if ask.get("guidance") is not None and "guidance_scale" in accepts:
            args["guidance_scale"] = ask["guidance"]
        if "generator" in accepts:
            args["generator"] = torch.Generator("cpu").manual_seed(int(ask.get("seed", 0)))
        used = 0
        if ask.get("images") and "image" in accepts:
            from PIL import Image
            pictures = [Image.open(path).convert("RGB") for path in ask["images"]]
            args["image"] = pictures if len(pictures) > 1 else pictures[0]
            used = len(pictures)
        pipe(**args).images[0].save(ask["out"])
        say({"id": ask["id"], "ok": True, "references": used})
    except Exception as error:
        say({"id": ask.get("id"), "error": str(error) or type(error).__name__, "trace": traceback.format_exc()[-600:]})
`

interface Worker {
  child: ChildProcessWithoutNullStreams
  ready: Promise<{ pipeline: string; device: string; negative: boolean; image: boolean }>
  /** Answers waited for, by request id. */
  waiting: Map<string, { resolve: (value: { references: number }) => void; reject: (error: Error) => void }>
  /** One picture at a time: a model on one device does not draw two at once. */
  tail: Promise<unknown>
  folder: Promise<string>
  idle?: ReturnType<typeof setTimeout>
  gone: boolean
  /** The last of what it wrote beside its answers: why it died, when it did. */
  noise: string
}

const workers = new Map<string, Worker>()
/** A worker nobody has asked anything of for this long is let go, and its model with it. */
const IDLE_MS = 10 * 60_000

function startWorker(key: string, python: string, model: string, device: string, dtype: string): Worker {
  const child = spawn(python, ['-u', '-c', DIFFUSERS_WORKER, model, device, dtype], { stdio: ['pipe', 'pipe', 'pipe'] })
  let ready!: { resolve: (value: { pipeline: string; device: string; negative: boolean; image: boolean }) => void; reject: (error: Error) => void }
  const worker: Worker = {
    child,
    ready: new Promise((resolve, reject) => { ready = { resolve, reject } }),
    waiting: new Map(),
    tail: Promise.resolve(),
    folder: mkdtemp(join(tmpdir(), 'novel-studio-diffusers-')),
    gone: false,
    noise: '',
  }
  // Nobody may be listening yet when it fails to start; the failure is told to whoever asks next.
  worker.ready.catch(() => {})
  worker.folder.catch(() => {})
  const fail = (error: Error): void => {
    if (worker.gone) return
    worker.gone = true
    workers.delete(key)
    if (worker.idle !== undefined) clearTimeout(worker.idle)
    ready.reject(error)
    for (const asked of worker.waiting.values()) asked.reject(error)
    worker.waiting.clear()
    void worker.folder.then(folder => rm(folder, { recursive: true, force: true })).catch(() => {})
  }
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line.startsWith('{')) continue
      let message: { ready?: boolean; fatal?: string; id?: string; ok?: boolean; error?: string; references?: number; pipeline?: string; device?: string; negative?: boolean; image?: boolean }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.fatal !== undefined) fail(new ProviderError(`Diffusers: ${message.fatal}`))
      else if (message.ready === true) ready.resolve({ pipeline: message.pipeline ?? '', device: message.device ?? '', negative: message.negative === true, image: message.image === true })
      else if (message.id !== undefined) {
        const asked = worker.waiting.get(message.id)
        worker.waiting.delete(message.id)
        if (message.ok === true) asked?.resolve({ references: message.references ?? 0 })
        else asked?.reject(new ProviderError(`Diffusers could not draw it: ${message.error ?? 'no reason given'}`))
      }
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { worker.noise = (worker.noise + chunk).slice(-1500) })
  child.on('error', (error) => { fail(new ProviderError(`could not start Python for Diffusers ("${python}"): ${error.message} — set the Python to run under Image generation`)) })
  child.on('exit', (code) => { fail(new ProviderError(`the Diffusers worker stopped${code !== null ? ` (exit ${code})` : ''}${worker.noise.trim().length > 0 ? `: ${worker.noise.trim().split('\n').slice(-3).join(' ')}` : ''}`)) })
  child.stdin.on('error', () => {})
  workers.set(key, worker)
  return worker
}

/** Let every Diffusers worker go — when the Studio's backend is taken down. */
export function stopLocalWorkers(): void {
  for (const worker of workers.values()) worker.child.kill()
}

export class DiffusersImages implements ImageProvider {
  readonly kind = 'diffusers' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings) {
    this.model = settings.model?.trim() ?? ''
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (this.model.length === 0) throw new ProviderError('Diffusers needs a model: a Hugging Face id (stabilityai/stable-diffusion-xl-base-1.0) or the path of a folder or .safetensors file on this computer')
    const python = this.settings.python?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
    const device = this.settings.device?.trim() || 'auto'
    const dtype = this.settings.dtype?.trim() || 'auto'
    const model = this.model.replace(/^~(?=$|[\\/])/, homedir())
    const key = [python, model, device, dtype].join('\u0000')
    const worker = workers.get(key) ?? startWorker(key, python, model, device, dtype)
    if (worker.idle !== undefined) clearTimeout(worker.idle)
    const { width, height } = sides(request.size ?? this.settings.size)
    const negative = request.negativePrompt ?? this.settings.negativePrompt ?? ''
    const stopped = (): Error => (request.signal?.reason instanceof Error ? request.signal.reason : new Error('aborted'))
    // Asked each time: the author may stop it at any moment of a long wait.
    const aborted = (): boolean => request.signal?.aborted === true
    const draw = async (): Promise<ImageResult> => {
      if (aborted()) throw stopped()
      // Loading a model — the first time, fetching it — takes as long as it takes; only the author stops it.
      const onAbort = (): void => { worker.child.kill() }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const able = await worker.ready
        const folder = await worker.folder
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const out = join(folder, `${id}.png`)
        const references: ImageReference[] = able.image ? request.references ?? [] : []
        const images: string[] = []
        for (const [index, reference] of references.entries()) {
          const path = join(folder, `${id}-ref${index + 1}.${extensionOf(reference.mime)}`)
          await writeFile(path, reference.data)
          images.push(path)
        }
        // A pipeline with no negative prompt of its own is told in the prompt, as the services without one are.
        const prompt = !able.negative && negative.length > 0 ? `${request.prompt}\n\nAvoid: ${negative}` : request.prompt
        const answered = new Promise<{ references: number }>((resolve, reject) => { worker.waiting.set(id, { resolve, reject }) })
        worker.child.stdin.write(`${JSON.stringify({ id, prompt, ...(able.negative && negative.length > 0 ? { negative } : {}), width, height, steps: this.settings.steps, guidance: this.settings.guidance, seed: newSeed(), out, images })}\n`)
        try {
          const done = await answered
          const data = new Uint8Array(await readFile(out))
          return { data, mime: 'image/png', referencesUsed: done.references, sent: { prompt, ...(able.negative && negative.length > 0 ? { negative } : {}), size: `${width}x${height}` } }
        } finally {
          await Promise.all([out, ...images].map(path => rm(path, { force: true }))).catch(() => {})
        }
      } catch (error) {
        if (aborted()) throw stopped()
        throw error
      } finally {
        request.signal?.removeEventListener('abort', onAbort)
      }
    }
    const turn = worker.tail.then(draw, draw)
    worker.tail = turn.catch(() => {})
    try {
      return await turn
    } finally {
      if (!worker.gone && worker.waiting.size === 0) {
        worker.idle = setTimeout(() => { worker.child.kill() }, IDLE_MS)
        worker.idle.unref?.()
      }
    }
  }
}

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
import type { ImageSettings } from '../../shared/types'
import { ProviderError, trimBase } from './http'
import type { ImageProvider, ImageReference, ImageRequest, ImageResult } from './image'

export const COMFY_DEFAULT = 'http://127.0.0.1:8188'

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
function checkpointGraph(model: string): Graph {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: '%steps%', cfg: '%scale%', sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'novel-studio', images: ['8', 0] } },
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
    throw new ProviderError('this ComfyUI workflow is in the editor\'s format, which the server does not run: export it in API format (Workflow → Export (API)) and name that file')
  }
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
    if (source !== undefined && source.trim().length > 0) graph = await readWorkflow(source)
    else {
      if (model.length === 0) {
        // No checkpoint named: the first one the server has.
        const listed = await this.call('/object_info/CheckpointLoaderSimple', {}, request.signal)
        const info = listed.ok ? await listed.json() as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [unknown] } } } } : {}
        const first = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
        model = Array.isArray(first) && typeof first[0] === 'string' ? first[0] : ''
        if (model.length === 0) throw new ProviderError('ComfyUI has no checkpoint to draw with: name one under Model, or name a workflow file')
      }
      graph = checkpointGraph(model)
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
      steps: this.settings.steps ?? 25,
      scale: this.settings.guidance ?? 7,
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
      sent: { prompt: request.prompt, ...(negative.length > 0 ? { negative } : {}), size: `${width}x${height}` },
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

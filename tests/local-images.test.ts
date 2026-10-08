// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures from the author's own machine: a ComfyUI server spoken to over its
 * HTTP API, and a Diffusers worker spoken to over its streams. Neither is on
 * the machine these tests run on, so each is stood in for by something that
 * speaks the same protocol — which is what the Studio's half is held to.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createImageProvider } from '../src/core/media/image'
import { comfyCatalog, comfyLastWorkflow, comfySampling, comfyTakeWorkflow, comfyWorkflows, editorToApi, fillWorkflow, stopLocalWorkers, workflowImages, workflowTemplate } from '../src/core/media/local'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const keys = { get: async () => undefined } as never
const folder = mkdtempSync(join(tmpdir(), 'novel-local-images-'))

describe('a workflow\'s placeholders', () => {
  it('fills a value in with its type where the string is the placeholder alone, as text elsewhere', () => {
    const graph = { 1: { inputs: { text: '%prompt%', width: '%width%', note: 'seed %seed% of %unknown%', list: ['%height%', ['4', 0]] } } }
    expect(fillWorkflow(graph, { prompt: '一座桥', width: 1024, height: 768, seed: 7 })).toEqual({ 1: { inputs: { text: '一座桥', width: 1024, note: 'seed 7 of %unknown%', list: [768, ['4', 0]] } } })
    expect(workflowImages(graph)).toBe(0)
    expect(workflowImages({ 2: { inputs: { image: '%image1%' } }, 3: { inputs: { image: '%image3%' } } })).toBe(3)
  })
})

/** What a server says of the nodes the workflows below are made of. */
const INFO = {
  UNETLoader: { input: { required: { unet_name: [['noct.safetensors']], weight_dtype: [['default']] } }, input_order: { required: ['unet_name', 'weight_dtype'] } },
  CLIPLoader: { input: { required: { clip_name: [['enc-8b.safetensors']], type: [['qwen_image']] }, optional: { device: [['default', 'cpu']] } }, input_order: { required: ['clip_name', 'type'], optional: ['device'] } },
  VAELoader: { input: { required: { vae_name: [['image-vae.safetensors']] } }, input_order: { required: ['vae_name'] } },
  TextEncodeQwenImage21: { input: { required: { clip: ['CLIP', {}], prompt: ['STRING', { multiline: true }], negative_prompt: ['STRING', { multiline: true }], resolution: ['INT', { default: 1024 }], images: ['COMFY_AUTOGROW_V3', { names: ['image_1', 'image_2', 'image_3'] }] }, optional: { vae: ['VAE', {}] } }, input_order: { required: ['clip', 'prompt', 'negative_prompt', 'resolution', 'images'], optional: ['vae'] } },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } }, input_order: { required: ['width', 'height', 'batch_size'] } },
  KSampler: { input: { required: { model: ['MODEL', {}], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler']], scheduler: [['simple']], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], denoise: ['FLOAT', {}] } }, input_order: { required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'] } },
  VAEDecode: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}] } }, input_order: { required: ['samples', 'vae'] } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } }, input_order: { required: ['images', 'filename_prefix'] }, output_node: true },
  LoadImage: { input: { required: { image: [['a.png'], { image_upload: true }] } }, input_order: { required: ['image'] } },
}

/**
 * A workflow as the editor saves it: a diffusion model loaded by parts, one node encoding both prompts and taking a
 * reference picture, a second picture loader left unconnected, and a note.
 * @param named - whether the file names the widgets among a node's inputs (newer editors do; older ones list only what is linked).
 */
function savedWorkflow(named: boolean) {
  const widget = (name: string, type: string) => (named ? [{ name, type, link: null, widget: { name } }] : [])
  return {
    version: 0.4,
    nodes: [
      { id: 1, type: 'UNETLoader', mode: 0, inputs: [...widget('unet_name', 'COMBO'), ...widget('weight_dtype', 'COMBO')], widgets_values: ['noct.safetensors', 'default'] },
      { id: 2, type: 'CLIPLoader', mode: 0, inputs: [...widget('clip_name', 'COMBO'), ...widget('type', 'COMBO'), ...widget('device', 'COMBO')], widgets_values: ['enc-8b.safetensors', 'qwen_image', 'default'] },
      { id: 3, type: 'VAELoader', mode: 0, inputs: widget('vae_name', 'COMBO'), widgets_values: ['image-vae.safetensors'] },
      { id: 4, type: 'TextEncodeQwenImage21', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 1 }, { name: 'images.image_1', type: 'IMAGE', link: 10 }, { name: 'images.image_2', type: 'IMAGE', link: null }, { name: 'vae', type: 'VAE', link: 9 }, ...widget('prompt', 'STRING'), ...widget('negative_prompt', 'STRING'), ...widget('resolution', 'INT')], widgets_values: ['the subject of picture 1, on the moon', 'blurry', 768] },
      { id: 5, type: 'EmptyLatentImage', mode: 0, inputs: [...widget('width', 'INT'), ...widget('height', 'INT'), ...widget('batch_size', 'INT')], widgets_values: [768, 768, 1] },
      { id: 6, type: 'KSampler', mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 2 }, { name: 'positive', type: 'CONDITIONING', link: 3 }, { name: 'negative', type: 'CONDITIONING', link: 4 }, { name: 'latent_image', type: 'LATENT', link: 5 }, ...widget('seed', 'INT'), ...widget('steps', 'INT'), ...widget('cfg', 'FLOAT'), ...widget('sampler_name', 'COMBO'), ...widget('scheduler', 'COMBO'), ...widget('denoise', 'FLOAT')], widgets_values: [20261009, 'randomize', 25, 3, 'euler', 'simple', 1] },
      { id: 7, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 6 }, { name: 'vae', type: 'VAE', link: 7 }] },
      { id: 8, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 8 }, ...widget('filename_prefix', 'STRING')], widgets_values: ['mine/reference'] },
      { id: 9, type: 'MarkdownNote', mode: 0, inputs: [], widgets_values: ['how to use this'] },
      { id: 10, type: 'LoadImage', mode: 0, inputs: [...widget('image', 'COMBO'), ...widget('upload', 'IMAGEUPLOAD')], widgets_values: ['sample.png', 'image'] },
      { id: 11, type: 'LoadImage', mode: 0, inputs: [...widget('image', 'COMBO'), ...widget('upload', 'IMAGEUPLOAD')], widgets_values: ['other.png', 'image'] },
    ],
    links: [[1, 2, 0, 4, 0, 'CLIP'], [2, 1, 0, 6, 0, 'MODEL'], [3, 4, 0, 6, 1, 'CONDITIONING'], [4, 4, 1, 6, 2, 'CONDITIONING'], [5, 5, 0, 6, 3, 'LATENT'], [6, 6, 0, 7, 0, 'LATENT'], [7, 3, 0, 7, 1, 'VAE'], [8, 7, 0, 8, 0, 'IMAGE'], [9, 3, 0, 4, 3, 'VAE'], [10, 10, 0, 4, 1, 'IMAGE']],
  }
}

describe('a workflow as ComfyUI\'s editor saves it', () => {
  const RUNS = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'noct.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'enc-8b.safetensors', type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'image-vae.safetensors' } },
    4: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'the subject of picture 1, on the moon', negative_prompt: 'blurry', resolution: 768, clip: ['2', 0], 'images.image_1': ['10', 0], vae: ['3', 0] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768, batch_size: 1 } },
    6: { class_type: 'KSampler', inputs: { seed: 20261009, steps: 25, cfg: 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0] } },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    8: { class_type: 'SaveImage', inputs: { filename_prefix: 'mine/reference', images: ['7', 0] } },
    10: { class_type: 'LoadImage', inputs: { image: 'sample.png' } },
  }

  it('becomes the graph the server runs: every widget by its name, the editor\'s own things left out', () => {
    // Whether the file names its widgets or not, the same graph: the seed without what the editor does with it after a
    // run, the picture without its upload button, no note, and no picture loader that leads nowhere.
    expect(editorToApi(savedWorkflow(true), INFO)).toEqual(RUNS)
    expect(editorToApi(savedWorkflow(false), INFO)).toEqual(RUNS)
  })

  it('reads through the editor\'s helpers, leaves out what is switched off, and says what it cannot tell', () => {
    const file = savedWorkflow(true)
    // The model comes through a reroute, the steps from a primitive; a muted loader feeds the second picture.
    file.nodes.push({ id: 20, type: 'Reroute', mode: 0, inputs: [{ name: '', type: '*', link: 2 }] } as never)
    file.nodes.push({ id: 21, type: 'PrimitiveNode', mode: 0, inputs: [], widgets_values: [12, 'fixed'] } as never)
    file.nodes.find(node => node.id === 11)!.mode = 2
    file.links = file.links.filter(link => link[0] !== 2)
    file.links.push([2, 1, 0, 20, 0, 'MODEL'], [30, 20, 0, 6, 0, 'MODEL'], [31, 21, 0, 6, 5, 'INT'], [32, 11, 0, 4, 2, 'IMAGE'])
    const sampler = file.nodes.find(node => node.id === 6)!
    sampler.inputs.find(input => input.name === 'model')!.link = 30
    sampler.inputs.find(input => input.name === 'steps')!.link = 31
    file.nodes.find(node => node.id === 4)!.inputs.find(input => input.name === 'images.image_2')!.link = 32
    const graph = editorToApi(file, INFO)
    expect(graph[6]!.inputs).toMatchObject({ model: ['1', 0], steps: 12, cfg: 3 })
    expect(Object.keys(graph[4]!.inputs!)).not.toContain('images.image_2')
    expect(Object.keys(graph).sort()).toEqual(['1', '10', '2', '3', '4', '5', '6', '7', '8'])
    // A node on bypass, and a workflow with subgraphs, cannot be told from the file: said, with the way out.
    file.nodes.find(node => node.id === 10)!.mode = 4
    expect(() => editorToApi(file, INFO)).toThrow('switched to bypass (LoadImage)')
    expect(() => editorToApi({ ...savedWorkflow(true), definitions: { subgraphs: [{}] } }, INFO)).toThrow('has subgraphs')
    expect(() => editorToApi({ 1: { class_type: 'X' } }, INFO)).toThrow('not a workflow as ComfyUI saves it')
    // Its words, size, seed — and the picture it loads — are the Studio's to fill.
    const made = workflowTemplate(RUNS)!
    expect(made.images).toBe(1)
    expect((made.workflow as Record<string, { inputs: Record<string, unknown> }>)[10]!.inputs.image).toBe('%image1%')
    const three = workflowTemplate({ ...RUNS, 4: { ...RUNS[4], inputs: { ...RUNS[4].inputs, 'images.image_1': ['12', 0], 'images.image_2': ['10', 0] } }, 12: { class_type: 'LoadImage', inputs: { image: 'first.png' } } })!
    // By the input each feeds — picture 1 before picture 2 —, not by their numbers.
    expect([(three.workflow as Record<string, { inputs: Record<string, unknown> }>)[12]!.inputs.image, (three.workflow as Record<string, { inputs: Record<string, unknown> }>)[10]!.inputs.image, three.images]).toEqual(['%image1%', '%image2%', 2])
  })
})

describe('ComfyUI', () => {
  let server: Server
  let base = ''
  const seen: { prompts: Record<string, unknown>[]; uploads: number; interrupted: number; fail?: 'queue' | 'run'; checkpoints: string[]; runs: Record<string, unknown> } = { prompts: [], uploads: 0, interrupted: 0, checkpoints: ['first.safetensors', 'second.safetensors'], runs: {} }
  // A run as a server keeps it: a diffusion model that comes alone, one node encoding both prompts.
  const RUN = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'noct.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'enc-8b.safetensors', type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'image-vae.safetensors' } },
    4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: 'a cat on a roof', negative_prompt: 'blurry', resolution: 1024 } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768, batch_size: 1 } },
    6: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], seed: 20261009, steps: 25, cfg: 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'mine/cat' } },
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://x')
        const json = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
        if (url.pathname === '/object_info/CheckpointLoaderSimple') return json(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [seen.checkpoints] } } } })
        if (url.pathname === '/object_info/UNETLoader') return json(200, { UNETLoader: { input: { required: { unet_name: [['noct.safetensors', 'video.safetensors']], weight_dtype: [['default']] } } } })
        // (The newer shape of a list of choices.)
        if (url.pathname === '/object_info/CLIPLoader') return json(200, { CLIPLoader: { input: { required: { clip_name: ['COMBO', { options: ['enc-32b.safetensors', 'enc-8b.safetensors'] }], type: [['sd3', 'qwen_image', 'flux2']] }, optional: { device: [['default', 'cpu']] } } } })
        if (url.pathname === '/object_info/VAELoader') return json(200, { VAELoader: { input: { required: { vae_name: [['video-vae.safetensors', 'image-vae.safetensors', 'taesd', 'pixel_space']] } } } })
        if (url.pathname === '/system_stats') return json(200, { system: { comfyui_version: '0.39.0' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4080 SUPER : cudaMallocAsync', vram_total: 16 * 2 ** 30 }] })
        if (url.pathname === '/history') return json(200, seen.runs)
        // What the author saved in the editor: listed, and handed over as the editor saved it.
        if (url.pathname === '/userdata' && url.searchParams.get('dir') === 'workflows') return json(200, [{ path: 'noct/reference.json', size: 1 }, { path: 'text.json', size: 1 }, { path: 'notes.txt', size: 1 }])
        if (url.pathname === `/userdata/${encodeURIComponent('workflows/noct/reference.json')}`) return json(200, savedWorkflow(true))
        if (url.pathname === `/userdata/${encodeURIComponent('workflows/text.json')}`) return json(200, { ...savedWorkflow(false), nodes: savedWorkflow(false).nodes.filter(node => node.type !== 'LoadImage').map(node => (node.id === 4 ? { ...node, inputs: node.inputs.filter(input => !input.name.startsWith('images.') && input.name !== 'vae') } : node)), links: savedWorkflow(false).links.filter(link => link[0] !== 9 && link[0] !== 10) })
        if (url.pathname.startsWith('/object_info/') && decodeURIComponent(url.pathname.slice('/object_info/'.length)) in INFO) {
          const type = decodeURIComponent(url.pathname.slice('/object_info/'.length)) as keyof typeof INFO
          return json(200, { [type]: INFO[type] })
        }
        if (url.pathname === '/upload/image') { seen.uploads += 1; return json(200, { name: `up-${seen.uploads}.png`, subfolder: '', type: 'input' }) }
        if (url.pathname === '/interrupt') { seen.interrupted += 1; return json(200, {}) }
        if (url.pathname === '/prompt') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { prompt: Record<string, unknown> }
          seen.prompts.push(body.prompt)
          if (seen.fail === 'queue') return json(400, { error: { message: 'Prompt outputs failed validation' }, node_errors: { 4: { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: 'ckpt_name' }] } } })
          return json(200, { prompt_id: `p${seen.prompts.length}`, number: 1, node_errors: {} })
        }
        if (url.pathname.startsWith('/history/')) {
          const id = url.pathname.slice('/history/'.length)
          if (seen.fail === 'run') return json(200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]] } } })
          return json(200, { [id]: { outputs: { 9: { images: [{ filename: 'novel-studio_00001_.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } })
        }
        if (url.pathname === '/view') { response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PNG)); return }
        json(404, {})
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise(resolve => server.close(resolve)) })

  it('draws with the built-in graph for a checkpoint: queues it, waits, fetches the picture', async () => {
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'second.safetensors', steps: 12 }, keys)!
    expect([provider.kind, provider.model]).toEqual(['comfyui', 'second.safetensors'])
    const result = await provider.generate({ prompt: '少女，三视图', negativePrompt: '辫子', size: '1280x720', references: [{ data: PNG, mime: 'image/png' }] })
    expect(Array.from(result.data)).toEqual(Array.from(PNG))
    expect(result.mime).toBe('image/png')
    const graph = seen.prompts.at(-1) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(graph[4]!.inputs.ckpt_name).toBe('second.safetensors')
    expect(graph[6]!.inputs.text).toBe('少女，三视图')
    expect(graph[7]!.inputs.text).toBe('辫子')
    // Sizes a latent model can make, as numbers; the author's steps, the default guidance; a seed of its own.
    expect(graph[5]!.inputs).toMatchObject({ width: 1280, height: 720 })
    expect(graph[3]!.inputs).toMatchObject({ steps: 12, cfg: 7 })
    expect(typeof graph[3]!.inputs.seed).toBe('number')
    // The built-in graph has no place for a reference picture: none went, and the result says so.
    expect(seen.uploads).toBe(0)
    expect(result.referencesUsed).toBe(0)
    // What went to the model, word for word.
    expect(result.sent).toEqual({ prompt: '少女，三视图', negative: '辫子', size: '1280x720', sampling: { steps: 12, guidance: 7, sampler: 'euler', scheduler: 'normal', from: 'builtin' } })
    // No checkpoint named: the first the server has.
    await createImageProvider({ provider: 'comfyui', baseURL: base }, keys)!.generate({ prompt: 'x' })
    expect((seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>)[4]!.inputs.ckpt_name).toBe('first.safetensors')
  })

  it('says what the server has, and draws with a diffusion model that comes alone beside its encoder and VAE', async () => {
    // Asked of the server itself: nobody types a file name from memory.
    const catalog = await comfyCatalog(base)
    expect(catalog).toEqual({
      base,
      version: '0.39.0',
      device: 'NVIDIA GeForce RTX 4080 SUPER · 16 GB',
      checkpoints: ['first.safetensors', 'second.safetensors'],
      diffusion: ['noct.safetensors', 'video.safetensors'],
      encoders: ['enc-32b.safetensors', 'enc-8b.safetensors'],
      vaes: ['video-vae.safetensors', 'image-vae.safetensors'],
      encoderTypes: ['sd3', 'qwen_image', 'flux2'],
      workflows: ['noct/reference.json', 'text.json'],
    })
    await expect(comfyCatalog('http://127.0.0.1:9')).rejects.toThrow('did not answer')
    // A model the server lists among its diffusion models: loaded by parts, with what the settings name beside it.
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'noct.safetensors', textEncoder: 'enc-8b.safetensors', vae: 'image-vae.safetensors', encoderType: 'qwen_image', guidance: 3 }, keys)!
    await provider.generate({ prompt: '一座桥', negativePrompt: '人', size: '768x768' })
    const graph = seen.prompts.at(-1) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(Object.values(graph).map(node => node.class_type).sort()).toEqual(['CLIPLoader', 'CLIPTextEncode', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'SaveImage', 'UNETLoader', 'VAEDecode', 'VAELoader'])
    expect(graph[1]!.inputs).toMatchObject({ unet_name: 'noct.safetensors' })
    expect(graph[2]!.inputs).toEqual({ clip_name: 'enc-8b.safetensors', type: 'qwen_image' })
    expect(graph[3]!.inputs).toEqual({ vae_name: 'image-vae.safetensors' })
    expect([graph[6]!.inputs.text, graph[7]!.inputs.text]).toEqual(['一座桥', '人'])
    expect(graph[4]!.inputs).toMatchObject({ steps: 25, cfg: 3, model: ['1', 0], positive: ['6', 0], negative: ['7', 0] })
    // Where the server leaves a choice and the settings make none, it is said what to name — nothing is guessed.
    await expect(createImageProvider({ provider: 'comfyui', baseURL: base, model: 'noct.safetensors' }, keys)!.generate({ prompt: 'x' })).rejects.toThrow(/comes alone.*a text encoder \(enc-32b\.safetensors, enc-8b\.safetensors\).*a VAE.*the kind the encoder is loaded as/)
    // A name the server does not have: said, with what it has.
    await expect(createImageProvider({ provider: 'comfyui', baseURL: base, model: 'gone.safetensors' }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('has no model "gone.safetensors" — it has: first.safetensors')
    // No checkpoint at all, and no model named: the diffusion models are named, and where to choose.
    seen.checkpoints = []
    try {
      await expect(createImageProvider({ provider: 'comfyui', baseURL: base }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('has no checkpoint, and 2 diffusion models (noct.safetensors, video.safetensors)')
    } finally {
      seen.checkpoints = ['first.safetensors', 'second.safetensors']
    }
  })

  it('samples a graph built here as the server last ran that model, unless the settings say', async () => {
    const parts = { provider: 'comfyui' as const, baseURL: base, model: 'noct.safetensors', textEncoder: 'enc-8b.safetensors', vae: 'image-vae.safetensors', encoderType: 'qwen_image' }
    const sampler = (): Record<string, unknown> => (seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>)[4]!.inputs
    // Nothing set, and the server has never run it: the figures for a model of its kind — not a checkpoint's 7, which burns it.
    const plain = await createImageProvider(parts, keys)!.generate({ prompt: '一座桥' })
    expect(sampler()).toMatchObject({ steps: 25, cfg: 3.5, sampler_name: 'euler', scheduler: 'simple' })
    expect(plain.sent?.sampling).toEqual({ steps: 25, guidance: 3.5, sampler: 'euler', scheduler: 'simple', from: 'builtin' })
    seen.runs = {
      // The author's own run of the model — and a newer one of another model, and the Studio's own guess, which do not count before it.
      mine: { prompt: [5, 'mine', { ...RUN, 6: { ...RUN[6], inputs: { ...RUN[6].inputs, steps: 30, cfg: 2.5, sampler_name: 'dpmpp_2m', scheduler: 'sgm_uniform' } } }], outputs: { 8: { images: [{ filename: 'cat.png' }] } }, status: { status_str: 'success' } },
      other: { prompt: [6, 'other', { ...RUN, 1: { class_type: 'UNETLoader', inputs: { unet_name: 'video.safetensors' } }, 6: { ...RUN[6], inputs: { ...RUN[6].inputs, cfg: 9 } } }], outputs: { 8: { images: [{ filename: 'v.png' }] } }, status: { status_str: 'success' } },
      studio: { prompt: [7, 'studio', { ...RUN, 6: { ...RUN[6], inputs: { ...RUN[6].inputs, cfg: 7 } }, 8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'novel-studio' } } }], outputs: { 8: { images: [{ filename: 'novel-studio_1.png' }] } }, status: { status_str: 'success' } },
    }
    try {
      expect(await comfySampling(base, 'noct.safetensors')).toEqual({ steps: 30, cfg: 2.5, sampler: 'dpmpp_2m', scheduler: 'sgm_uniform' })
      expect(await comfySampling(base, 'second.safetensors')).toBeUndefined()
      const found = await createImageProvider(parts, keys)!.generate({ prompt: '一座桥' })
      expect(sampler()).toMatchObject({ steps: 30, cfg: 2.5, sampler_name: 'dpmpp_2m', scheduler: 'sgm_uniform' })
      expect(found.sent?.sampling).toEqual({ steps: 30, guidance: 2.5, sampler: 'dpmpp_2m', scheduler: 'sgm_uniform', from: 'server' })
      // What the settings say holds over it — figure by figure.
      const half = await createImageProvider({ ...parts, guidance: 4 }, keys)!.generate({ prompt: '一座桥' })
      expect(sampler()).toMatchObject({ steps: 30, cfg: 4 })
      expect(half.sent?.sampling?.from).toBe('server')
      const set = await createImageProvider({ ...parts, guidance: 4, steps: 10 }, keys)!.generate({ prompt: '一座桥' })
      expect(sampler()).toMatchObject({ steps: 10, cfg: 4, sampler_name: 'dpmpp_2m' })
      expect(set.sent?.sampling?.from).toBe('settings')
    } finally {
      seen.runs = {}
    }
  })

  it('takes the server\'s last run that made a picture as the workflow to fill in', async () => {
    expect(await comfyLastWorkflow(base)).toBeUndefined()
    seen.runs = {
      // A run that failed, one that made no picture, and — older than both — the one that drew.
      c: { prompt: [9, 'c', RUN], outputs: {}, status: { status_str: 'error' } },
      b: { prompt: [8, 'b', { 1: { class_type: 'SaveText', inputs: {} } }], outputs: { 1: { text: ['x'] } }, status: { status_str: 'success' } },
      a: { prompt: [7, 'a', RUN], outputs: { 8: { images: [{ filename: 'cat.png' }] } }, status: { status_str: 'success' } },
      // Newer than all of them, and the Studio's own: it does not stand before the author's.
      d: { prompt: [10, 'd', { ...RUN, 4: { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } }, 6: { ...RUN[6], inputs: { ...RUN[6].inputs, negative: ['4', 0] } }, 8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'novel-studio' } } }], outputs: { 8: { images: [{ filename: 'novel-studio_1.png' }] } }, status: { status_str: 'success' } },
    }
    const last = (await comfyLastWorkflow(base))!
    expect(last.model).toBe('noct.safetensors')
    expect(last.nodes).toEqual(['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'])
    const graph = last.workflow as Record<string, { inputs: Record<string, unknown> }>
    // The words, the size and the seed are the Studio's to fill; the models and the sampling stay as the server ran them.
    expect(graph[4]!.inputs).toEqual({ clip: ['2', 0], prompt: '%prompt%', negative_prompt: '%negative_prompt%', resolution: 1024 })
    expect(graph[5]!.inputs).toEqual({ width: '%width%', height: '%height%', batch_size: 1 })
    expect(graph[6]!.inputs).toMatchObject({ seed: '%seed%', steps: 25, cfg: 3, sampler_name: 'euler', scheduler: 'simple' })
    expect(graph[1]!.inputs.unet_name).toBe('noct.safetensors')
    expect(graph[8]!.inputs.filename_prefix).toBe('novel-studio')
    expect((await comfyCatalog(base)).last).toEqual({ model: 'noct.safetensors', nodes: last.nodes })
    // Kept in the settings as it is, it draws.
    await createImageProvider({ provider: 'comfyui', baseURL: base, workflow: JSON.stringify(last.workflow) }, keys)!.generate({ prompt: '雨夜的码头', negativePrompt: '字', size: '1280x720' })
    const sent = seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>
    expect(sent[4]!.inputs).toMatchObject({ prompt: '雨夜的码头', negative_prompt: '字' })
    expect(sent[5]!.inputs).toMatchObject({ width: 1280, height: 720 })
    expect(typeof sent[6]!.inputs.seed).toBe('number')
    // Two text nodes, one a side; a guidance node between the text and the sampler; a sampler that names its seed otherwise.
    const two = workflowTemplate({
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'xl.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'a dog', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: 'ugly', clip: ['1', 1] } },
      4: { class_type: 'FluxGuidance', inputs: { conditioning: ['2', 0], guidance: 3.5 } },
      5: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      6: { class_type: 'KSamplerAdvanced', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['3', 0], latent_image: ['5', 0], noise_seed: 5, steps: 20 } },
    })!
    const made = two.workflow as Record<string, { inputs: Record<string, unknown> }>
    expect([made[2]!.inputs.text, made[3]!.inputs.text, made[6]!.inputs.noise_seed, made[5]!.inputs.width, two.model]).toEqual(['%prompt%', '%negative_prompt%', '%seed%', '%width%', 'xl.safetensors'])
    // What was handed over is left as it was; a graph with no sampler fed by a text is no template.
    expect(RUN[4].inputs.prompt).toBe('a cat on a roof')
    expect(workflowTemplate({ 1: { class_type: 'LoadImage', inputs: { image: 'x.png' } } })).toBeUndefined()
    expect(workflowTemplate(null)).toBeUndefined()
    seen.runs = {}
  })

  it('takes a workflow saved on the server as it is, and draws with it', async () => {
    expect(await comfyWorkflows(base)).toEqual(['noct/reference.json', 'text.json'])
    // Converted from what the editor saved, with the Studio's placeholders in it — the picture it loads among them.
    const withPicture = await comfyTakeWorkflow(base, 'noct/reference.json')
    expect([withPicture.model, withPicture.images, withPicture.nodes.length]).toEqual(['noct.safetensors', 1, 9])
    const plain = await comfyTakeWorkflow(base, 'text.json')
    expect([plain.images, plain.nodes]).toEqual([0, ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage']])
    await expect(comfyTakeWorkflow(base, 'gone.json')).rejects.toThrow('has no saved workflow "gone.json"')
    // Kept in the settings — with a note of where each came from, which is no node of the graph — they draw: the plain
    // one a picture from words, the other a picture held to its reference, uploaded and named in its place.
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, workflow: JSON.stringify({ ...plain.workflow, _novel: { from: 'text.json' } }), editWorkflow: JSON.stringify({ ...withPicture.workflow, _novel: { from: 'noct/reference.json' } }) }, keys)!
    await provider.generate({ prompt: '人设图', size: '1536x1024' })
    const first = seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>
    expect(Object.keys(first)).not.toContain('_novel')
    expect(first[4]!.inputs).toMatchObject({ prompt: '人设图', resolution: 768 })
    expect(Object.values(first).some(node => (node as { class_type?: string }).class_type === 'LoadImage')).toBe(false)
    const before = seen.uploads
    const held = await provider.generate({ prompt: '立绘', negativePrompt: '字', size: '768x1024', references: [{ data: PNG, mime: 'image/png' }, { data: PNG, mime: 'image/png' }] })
    const second = seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>
    // One place: one picture went, however many were offered.
    expect([seen.uploads - before, held.referencesUsed]).toEqual([1, 1])
    expect(second[10]!.inputs.image).toBe(`up-${seen.uploads}.png`)
    expect(second[4]!.inputs).toMatchObject({ prompt: '立绘', negative_prompt: '字', 'images.image_1': ['10', 0] })
    expect(second[5]!.inputs).toMatchObject({ width: 768, height: 1024 })
  })

  it('runs the author\'s own workflow, and the one that takes reference pictures where there are some', async () => {
    const plain = join(folder, 'plain.json')
    const edit = join(folder, 'edit.json')
    writeFileSync(plain, JSON.stringify({ 1: { class_type: 'MyLoader', inputs: { name: '%model%' } }, 2: { class_type: 'Text', inputs: { text: '%prompt% --no %negative_prompt%', w: '%width%', h: '%height%' } } }))
    writeFileSync(edit, JSON.stringify({ 1: { class_type: 'LoadImage', inputs: { image: '%image1%' } }, 2: { class_type: 'LoadImage', inputs: { image: '%image2%' } }, 3: { class_type: 'Text', inputs: { text: '%prompt%' } } }))
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'flux.gguf', workflow: plain, editWorkflow: edit }, keys)!
    const first = await provider.generate({ prompt: '桥', negativePrompt: '人', size: '1000x700' })
    expect(seen.prompts.at(-1)).toEqual({ 1: { class_type: 'MyLoader', inputs: { name: 'flux.gguf' } }, 2: { class_type: 'Text', inputs: { text: '桥 --no 人', w: 1008, h: 704 } } })
    expect(first.referencesUsed).toBe(0)
    // One reference, two places: the picture is uploaded once and shown in both.
    const before = seen.uploads
    const held = await provider.generate({ prompt: '她', references: [{ data: PNG, mime: 'image/png' }] })
    expect(seen.uploads).toBe(before + 1)
    const graph = seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>
    expect([graph[1]!.inputs.image, graph[2]!.inputs.image]).toEqual([`up-${seen.uploads}.png`, `up-${seen.uploads}.png`])
    expect(held.referencesUsed).toBe(1)
    // A workflow that needs a picture, asked for one with none: said, not queued.
    await expect(createImageProvider({ provider: 'comfyui', baseURL: base, workflow: edit }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('takes reference pictures')
    // The editor's own format is not what the server runs.
    await expect(createImageProvider({ provider: 'comfyui', baseURL: base, workflow: JSON.stringify({ nodes: [], links: [] }) }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('API format')
    await expect(createImageProvider({ provider: 'comfyui', baseURL: base, workflow: join(folder, 'missing.json') }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('could not be read')
  })

  it('says what the server said when a workflow is refused or fails, and when nothing answers', async () => {
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'first.safetensors' }, keys)!
    seen.fail = 'queue'
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/did not take the workflow: Prompt outputs failed validation — CheckpointLoaderSimple: Value not in list ckpt_name/)
    seen.fail = 'run'
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/failed while running the workflow \(KSampler\): out of memory/)
    delete seen.fail
    await expect(createImageProvider({ provider: 'comfyui', baseURL: 'http://127.0.0.1:9' }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('is it running?')
  })
})

describe.skipIf(process.platform === 'win32')('Diffusers', () => {
  // A stand-in for `python -u -c <worker> <model> <device> <dtype>`: it speaks the worker's lines.
  const python = join(folder, 'python-standin')
  const log = join(folder, 'asked.jsonl')
  beforeAll(() => {
    writeFileSync(python, `#!/usr/bin/env node
const fs = require('node:fs')
const [, , , , script, model, device, dtype] = process.argv
const say = message => process.stdout.write(JSON.stringify(message) + '\\n')
if (!script.includes('DiffusionPipeline.from_pretrained')) { say({ fatal: 'not the worker' }); process.exit(1) }
if (model === 'no/such-model') { say({ fatal: 'could not load ' + model + ': not found' }); process.exit(1) }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ started: model, device, dtype }) + '\\n')
say({ ready: true, device: 'cpu', dtype: 'float32', pipeline: 'StandIn', negative: model !== 'no/negative', image: model === 'takes/images' })
let buffer = ''
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
    const ask = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...ask, out: undefined, images: (ask.images || []).map(path => fs.readFileSync(path).length) }) + '\\n')
    if (ask.prompt === 'fail') { say({ id: ask.id, error: 'CUDA out of memory' }); continue }
    fs.writeFileSync(ask.out, Buffer.from(${JSON.stringify(Array.from(PNG))}))
    say({ id: ask.id, ok: true, references: (ask.images || []).length })
  }
})
`)
    chmodSync(python, 0o755)
  })
  afterAll(() => {
    stopLocalWorkers()
    rmSync(folder, { recursive: true, force: true })
  })
  const asked = async (): Promise<Record<string, unknown>[]> => (await import('node:fs')).readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

  it('starts one worker for a model, keeps it between pictures, and passes what the pipeline takes', async () => {
    const provider = createImageProvider({ provider: 'diffusers', python, model: 'org/model', steps: 20, guidance: 4.5 }, keys)!
    expect([provider.kind, provider.model]).toEqual(['diffusers', 'org/model'])
    const [first, second] = await Promise.all([
      provider.generate({ prompt: '一座桥', negativePrompt: '人', size: '1280x720', references: [{ data: PNG, mime: 'image/png' }] }),
      provider.generate({ prompt: '一条河' }),
    ])
    expect(Array.from(first.data)).toEqual(Array.from(PNG))
    expect(first.mime).toBe('image/png')
    expect(first.sent).toEqual({ prompt: '一座桥', negative: '人', size: '1280x720' })
    // This pipeline takes no picture: the reference stayed behind, and the result says so.
    expect(first.referencesUsed).toBe(0)
    expect(second.sent).toEqual({ prompt: '一条河', size: '1024x1024' })
    const lines = await asked()
    // One worker for both, with the model, and the device and precision left to it.
    expect(lines.filter(line => line.started !== undefined)).toEqual([{ started: 'org/model', device: 'auto', dtype: 'auto' }])
    expect(lines.find(line => line.prompt === '一座桥')).toMatchObject({ negative: '人', width: 1280, height: 720, steps: 20, guidance: 4.5, images: [] })
    // What the pipeline could not draw is said as it said it.
    await expect(provider.generate({ prompt: 'fail' })).rejects.toThrow('Diffusers could not draw it: CUDA out of memory')
  })

  it('hands reference pictures to a pipeline that takes them, and tells one without a negative prompt in the prompt', async () => {
    const edit = await createImageProvider({ provider: 'diffusers', python, model: 'takes/images' }, keys)!.generate({ prompt: '她', references: [{ data: PNG, mime: 'image/png' }, { data: PNG, mime: 'image/jpeg' }] })
    expect(edit.referencesUsed).toBe(2)
    expect((await asked()).find(line => line.prompt === '她')!.images).toEqual([PNG.length, PNG.length])
    const plain = await createImageProvider({ provider: 'diffusers', python, model: 'no/negative' }, keys)!.generate({ prompt: '桥', negativePrompt: '人' })
    expect(plain.sent).toEqual({ prompt: '桥\n\nAvoid: 人', size: '1024x1024' })
  })

  it('says why when the model does not load, the Python is not there, or no model is named', async () => {
    await expect(createImageProvider({ provider: 'diffusers', python, model: 'no/such-model' }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('could not load no/such-model: not found')
    await expect(createImageProvider({ provider: 'diffusers', python: join(folder, 'no-python-here'), model: 'org/model' }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('could not start Python')
    await expect(createImageProvider({ provider: 'diffusers', python }, keys)!.generate({ prompt: 'x' })).rejects.toThrow('needs a model')
  })
})

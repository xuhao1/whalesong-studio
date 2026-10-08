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
import { fillWorkflow, stopLocalWorkers, workflowImages } from '../src/core/media/local'

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

describe('ComfyUI', () => {
  let server: Server
  let base = ''
  const seen: { prompts: Record<string, unknown>[]; uploads: number; interrupted: number; fail?: 'queue' | 'run' } = { prompts: [], uploads: 0, interrupted: 0 }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://x')
        const json = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
        if (url.pathname === '/object_info/CheckpointLoaderSimple') return json(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['first.safetensors', 'second.safetensors']] } } } })
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
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'mine.safetensors', steps: 12 }, keys)!
    expect([provider.kind, provider.model]).toEqual(['comfyui', 'mine.safetensors'])
    const result = await provider.generate({ prompt: '少女，三视图', negativePrompt: '辫子', size: '1280x720', references: [{ data: PNG, mime: 'image/png' }] })
    expect(Array.from(result.data)).toEqual(Array.from(PNG))
    expect(result.mime).toBe('image/png')
    const graph = seen.prompts.at(-1) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    expect(graph[4]!.inputs.ckpt_name).toBe('mine.safetensors')
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
    expect(result.sent).toEqual({ prompt: '少女，三视图', negative: '辫子', size: '1280x720' })
    // No checkpoint named: the first the server has.
    await createImageProvider({ provider: 'comfyui', baseURL: base }, keys)!.generate({ prompt: 'x' })
    expect((seen.prompts.at(-1) as Record<string, { inputs: Record<string, unknown> }>)[4]!.inputs.ckpt_name).toBe('first.safetensors')
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
    const provider = createImageProvider({ provider: 'comfyui', baseURL: base, model: 'gone.safetensors' }, keys)!
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

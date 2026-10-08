// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Audio drama: a chapter becomes a performance script, then sound.
 *
 *   script      a director pass cuts the prose into lines — narration, dialogue,
 *               inner voice — names who speaks, how, and where ambience changes.
 *               Every word of the chapter is kept; a block whose script drifts
 *               from the text falls back to a deterministic cut.
 *   casting     each character speaks with one voice for the whole book: the
 *               voice on their card, a voice designed from their persona, or a
 *               stock voice picked once by gender and age. What was picked is
 *               kept in the book's voice sheet, so the next chapter casts the
 *               same way.
 *   synthesis   lines render in parallel and are cached by content, so editing
 *               one sentence re-renders one line. Every take is listened to by
 *               measurement — is the whole line there, is it this speaker's
 *               voice — and taken again when it is not; what is kept is brought
 *               to one level, so no line is a whisper beside a shout.
 *
 *   sound       besides the lines the script carries cues: the bed a scene sits
 *               on, a sound the page makes, a held chord. Each has a caption the
 *               reader can see. Beds are synthesized by the player in the
 *               browser; effects and music are generated when a sound model is
 *               set up (pipelines/sound.ts), and stay captions when none is.
 */
import type { AmbiencePreset, AudioCue, AudioLine, AudioScript, CharacterCard, NovelSettings, SoundKind, TakeIssue, TtsSettings, VoiceCast, VoicePrint } from '../../shared/types'
import { clip as clipText, hashText, proseOnly, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { ProviderError } from '../media/http'
import { similarity, type TtsProvider, type TtsRequest } from '../media/tts'
import { badness, judge, leveled, measure, speechUnits, TARGET_LEVEL, type TakeVerdict, type VoiceMeasure } from '../media/voiceprint'
import { AUDIOGEN_NARRATOR, castVoice, describesVoices, describeVoice, guessGender, providerDefaultVoice, stockVoices } from '../media/voices'
import { concatAudio, durationOf, encodeWav, parseWav, trimSilence, type PcmAudio } from '../media/wav'
import type { LocatedChapter, Project } from '../project'
import { ProjectError } from '../project'
import { audioScriptTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { errorMessage, KeyedMutex, mapLimit, serializer } from '../util/async'

export const AMBIENCE: Record<AmbiencePreset, [string, string]> = {
  none: ['无环境声（安静的室内）', 'silence (a quiet room)'],
  rain: ['雨声', 'rain'],
  storm: ['暴风雨、雷声', 'storm and thunder'],
  wind: ['风声（旷野、高处）', 'wind (open land, heights)'],
  night: ['夜晚虫鸣', 'night insects'],
  forest: ['林间鸟鸣与树叶声', 'forest: birds and leaves'],
  sea: ['海浪', 'sea waves'],
  river: ['溪流、水声', 'stream, running water'],
  fire: ['篝火、炉火', 'fire crackle'],
  city: ['城市街道的低噪', 'city street hum'],
  crowd: ['人群嘈杂', 'crowd murmur'],
  tavern: ['酒馆、集市的热闹', 'tavern or market bustle'],
  battle: ['战场、打斗的紧张轰鸣', 'battle rumble'],
  cave: ['洞穴的滴水与回响', 'cave drips and echo'],
  snow: ['雪原的寂静风声', 'snowfield hush'],
  train: ['列车、车厢行进声', 'train in motion'],
  spaceship: ['飞船舱内的低频嗡鸣', 'spaceship hum'],
  tension: ['悬疑紧张的低频氛围', 'low suspense drone'],
  serene: ['宁静温暖的氛围垫音', 'warm serene pad'],
}

const AMBIENCE_KEYS = Object.keys(AMBIENCE) as AmbiencePreset[]
const BLOCK_CHARS = 1600

/**
 * A chapter's script is changed by several hands at once — the booth saving
 * takes, the sound desk saving clips, the author editing a line: each change
 * is read, made and written under this lock, so none overwrites another.
 */
const scriptLocks = new KeyedMutex()

/**
 * Change a chapter's script as it stands on disk right now.
 * @param change - returns the script to save, or undefined to leave it.
 * @returns the saved script, or undefined when the chapter has none (or nothing was changed).
 */
export async function changeScript(project: Project, chapterId: string, change: (script: AudioScript) => AudioScript | undefined | Promise<AudioScript | undefined>): Promise<AudioScript | undefined> {
  return await scriptLocks.run(`${project.root}|${chapterId}`, async () => {
    const current = await project.audioScript(chapterId)
    if (current === undefined) return undefined
    const next = await change(current)
    if (next === undefined) return undefined
    await project.saveAudioScript(next)
    return next
  })
}

/** Casting reads the book's voice sheet, picks, and writes it back: one chapter at a time, or two would give one voice to two people. */
const castLocks = new KeyedMutex()

/** Reference clips being made right now, by book and file: a second chapter asking for the same voice waits for the first one's clip. */
const anchoring = new Map<string, Promise<PcmAudio | undefined>>()

export async function requireSpeech(core: NovelCore, runtime?: ProjectRuntime): Promise<TtsProvider> {
  const provider = await core.ttsProvider(runtime)
  if (provider === undefined) throw new ProviderError('speech synthesis is not configured — set a speech endpoint in Novel Studio → Settings', undefined, 'NOT_CONFIGURED')
  return provider
}

/** Cut prose into blocks on paragraph boundaries so each fits one director pass. */
function blocksOf(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let length = 0
  for (const paragraph of text.split('\n').filter(line => line.trim().length > 0)) {
    if (length + paragraph.length > BLOCK_CHARS && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
      length = 0
    }
    current.push(paragraph)
    length += paragraph.length
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

/** Opening quote → its closing partner. A straight quote closes itself. */
const QUOTES: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' }

/**
 * A quoted span that is talked about rather than spoken: a word in quotes, a
 * title, a sound. It has no sentence of its own, sits inside the narrator's
 * sentence, and stays there.
 */
function isMention(content: string, before: string, after: string): boolean {
  if (content.length > 8 || /[。！？!?…—~，,；;]$/u.test(content.trim())) return false
  // Introduced as speech ("她说：“好”") or standing alone as a paragraph: someone says it.
  if (/[：:]\s*$/u.test(before) || (before.trim().length === 0 && after.trim().length === 0)) return false
  return before.trim().length > 0 || /^[^\s，,。！？!?]/u.test(after)
}

/** Deterministic cut: quoted speech is dialogue, the rest narration. Used when the director pass cannot be trusted. */
export function fallbackLines(text: string): Omit<AudioLine, 'id'>[] {
  const lines: Omit<AudioLine, 'id'>[] = []
  for (const paragraph of text.split('\n').map(line => line.trim()).filter(line => line.length > 0)) {
    let buffer = ''
    const flush = (kind: AudioLine['kind'], content = buffer): void => {
      const body = content.trim()
      if (kind === 'narration') buffer = ''
      if (body.replace(/[\p{P}\s]/gu, '').length === 0) return
      // How much narration goes into one take is decided once for the whole script (tidyLines).
      lines.push({ kind, text: body })
    }
    for (let at = 0; at < paragraph.length; at++) {
      const char = paragraph[at]!
      const close = QUOTES[char]
      if (close === undefined) {
        buffer += char
        continue
      }
      const end = paragraph.indexOf(close, at + 1)
      // A quote that never closes runs to the end of the paragraph.
      const content = paragraph.slice(at + 1, end < 0 ? paragraph.length : end)
      const after = end < 0 ? '' : paragraph.slice(end + 1)
      if (end >= 0 && isMention(content, buffer, after)) buffer += `${char}${content}${close}`
      else {
        flush('narration')
        flush('dialogue', content)
      }
      at = end < 0 ? paragraph.length : end
    }
    flush('narration')
  }
  return lines
}

type DraftLine = Omit<AudioLine, 'id'>

/**
 * How much narration is spoken in one take, in syllables: long enough for the
 * narrator to find a stride and keep it, short enough to be checked and, when
 * a take goes wrong, taken again without redoing a page.
 */
export const TAKE_UNITS = 180
/** A take may run this much over rather than leave a few words behind as a take of their own. */
const TAKE_SLACK = 1.3
/** A take this short is folded into the one before it when there is room. */
const TAKE_TAIL = 40

const SENTENCE_END = /[。！？!?…”’」』.]\s*$/u

function joined(left: string, right: string): string {
  // Paragraphs and sentences keep a break between them; pieces of one sentence run on.
  if (SENTENCE_END.test(left)) return `${left}\n${right}`
  return /[A-Za-z0-9,;:'")\]]$/.test(left) && /^[A-Za-z0-9'"(\[]/.test(right) ? `${left} ${right}` : `${left}${right}`
}

const SAID_ZH = /(?:说|道|问|答|喊|嚷|吼|念|讲|骂|劝|催促|补充|开口|解释|提醒|回答|追问|反问|低语|嘀咕|嘟囔|喃喃|应声|接口|插嘴)(?:着|了|道|说)?$/u
const SAID_EN = /^(?:(?:[\w'’-]+\s){0,3}(?:said|says|asked|asks|replied|answered|whispered|shouted|muttered|murmured|added|called|cried|continued|went on)(?:\s[\w'’-]+){0,3}|(?:said|asked|replied|answered|whispered|shouted|muttered|added)\s(?:[\w'’-]+\s?){1,3})$/i

/**
 * Narration that only says who spoke: "他说，", "白页问道：", "she said quietly."
 * One clause, a handful of syllables, ending on a verb of saying.
 */
export function isSpeechTag(text: string): boolean {
  const body = text.trim().replace(/[，,：:。.！!？?…—\s]+$/u, '').replace(/^[，,—\s]+/u, '')
  if (body.length === 0 || /[，,。！？!?；;：:]/u.test(body)) return false
  // "没有回答", "不说" tell of a silence, which is something that happens.
  if (/[\u4e00-\u9fff]/u.test(body)) return speechUnits(body) <= 7 && !/[没不未别无]/u.test(body) && SAID_ZH.test(body)
  return body.split(/\s+/).length <= 6 && SAID_EN.test(body)
}

/** Cut a passage too long for one take at sentence ends, into pieces of about the same size. */
function splitTake(text: string): string[] {
  const total = speechUnits(text)
  if (total <= TAKE_UNITS * TAKE_SLACK) return [text]
  const sentences = text.match(/[^。！？!?…\n]+[。！？!?…]*["”’」』）)]*\s*|\n+/g) ?? [text]
  const target = total / Math.ceil(total / TAKE_UNITS)
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.trim().length > 0 && speechUnits(current) + speechUnits(sentence) / 2 > target) {
      pieces.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim().length > 0) pieces.push(current.trim())
  return pieces.length > 0 ? pieces : [text]
}

/**
 * Shape a script for speaking. Narration is where a fragmented script hurts
 * most — every line is its own take, and a narrator who starts over at each
 * paragraph never sounds like one person telling a story — so:
 *
 * - narration that follows narration is spoken in one take, up to TAKE_UNITS;
 * - a paragraph too long for one take is cut at sentence ends, evenly;
 * - a few words of narration that only say who spoke, stranded between two
 *   spoken lines, are marked as a tag: with a voice per speaker they are
 *   redundant, and they are the clips a speech model does worst.
 *
 * @returns the shaped lines, and for each line that came in the index of the line it ended up in.
 */
export function tidyLines(lines: DraftLine[]): { lines: DraftLine[]; map: number[] } {
  const out: DraftLine[] = []
  const map = new Array<number>(lines.length).fill(0)
  const narration = (index: number): boolean => lines[index]?.kind === 'narration'
  let at = 0
  while (at < lines.length) {
    if (!narration(at)) {
      out.push(lines[at]!)
      map[at] = out.length - 1
      at += 1
      continue
    }
    // A run of narration: everything up to the next spoken line.
    let end = at
    while (end + 1 < lines.length && narration(end + 1)) end += 1
    if (end === at && isSpeechTag(lines[at]!.text) && (at > 0 || at + 1 < lines.length)) {
      out.push({ ...lines[at]!, tag: true })
      map[at] = out.length - 1
      at += 1
      continue
    }
    const first = out.length
    let take: DraftLine | undefined
    const close = (): void => {
      if (take === undefined) return
      out.push(take)
      take = undefined
    }
    for (let index = at; index <= end; index++) {
      const line = lines[index]!
      for (const piece of splitTake(line.text)) {
        if (take !== undefined && speechUnits(take.text) + speechUnits(piece) > TAKE_UNITS) close()
        take = take === undefined
          ? { ...line, text: piece }
          : { ...take, text: joined(take.text, piece), ...(take.direction === undefined && line.direction !== undefined ? { direction: line.direction } : {}) }
        map[index] = out.length
      }
    }
    close()
    // A few words left over read better as the end of the take before them.
    const last = out.at(-1)!
    const before = out.length - 1 > first ? out[out.length - 2] : undefined
    if (before !== undefined && speechUnits(last.text) < TAKE_TAIL && speechUnits(before.text) + speechUnits(last.text) <= TAKE_UNITS * TAKE_SLACK) {
      out.pop()
      out[out.length - 1] = { ...before, text: joined(before.text, last.text) }
      for (let index = at; index <= end; index++) if (map[index]! > out.length - 1) map[index] = out.length - 1
    }
    at = end + 1
  }
  return { lines: out, map }
}

/** How scripts are shaped now; one without this mark was cut the older, finer way. */
export const SCRIPT_SHAPE = 2

/**
 * Whether a line is left unspoken: by the author's own word on it, or because
 * it is a speech tag and the book is not set to read every word.
 */
export function isSkipped(line: Pick<AudioLine, 'tag' | 'voiced' | 'kind'>, settings: Pick<TtsSettings, 'speechTags'>): boolean {
  if (line.voiced !== undefined) return !line.voiced
  return line.tag === true && settings.speechTags !== 'read'
}

/** A script as a player needs it: every line that will not be spoken says so. */
export function playable<T extends Pick<AudioScript, 'lines'>>(script: T, settings: Pick<TtsSettings, 'speechTags'>): T {
  return { ...script, lines: script.lines.map((line) => { const { skip: _skip, ...rest } = line; return isSkipped(line, settings) ? { ...rest, skip: true } : rest }) }
}

interface DraftCue {
  at: number
  kind: SoundKind
  ambience: AmbiencePreset
  intensity?: number
  caption?: string
  prompt?: string
}

/** What the director may place besides beds, by the author's settings. */
export function soundPlan(settings: NovelSettings): { effects: boolean; music: boolean; beds: 'generate' | 'browser' } {
  return { effects: settings.sound?.effects !== false, music: settings.sound?.music !== false, beds: settings.sound?.beds ?? 'generate' }
}

const cueKey = (cue: Pick<AudioCue, 'kind' | 'caption' | 'prompt' | 'ambience'>): string => `${cue.kind ?? 'bed'}|${cue.ambience}|${cue.caption ?? ''}|${cue.prompt ?? ''}`

/** Build (or rebuild) the performance script of a chapter. */
export async function buildAudioScript(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; force?: boolean }, task: TaskContext): Promise<AudioScript> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const text = proseOnly(await project.chapterText(chapter.plan.id))
  if (text.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text yet`)
  const textHash = hashText(text)
  const existing = await project.audioScript(chapter.plan.id)
  if (existing !== undefined && existing.textHash === textHash && params.force !== true) return existing

  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const resolve = (name: string): CharacterCard | undefined => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)
  const castText = castFor(chapter, characters, text).map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `(${card.aliases.join('/')})` : ''} | ${[card.gender, card.age, card.voice ?? card.personality].filter(Boolean).join('，')}`).join('\n')
  const ambienceText = AMBIENCE_KEYS.map(key => `${key}: ${AMBIENCE[key][lang === 'zh' ? 0 : 1]}`).join('\n')
  const sounds = soundPlan(await core.settings.get())
  const blocks = blocksOf(text)
  let done = 0
  task.job?.progress(0, blocks.length, L(lang, `编排有声脚本（共 ${blocks.length} 段）`, `directing the script (${blocks.length} passages)`))

  const results = await mapLimit(blocks, core.parallel('text'), async (block) => {
    let lines: DraftLine[] | undefined
    let cues: DraftCue[] = []
    let reason: string | undefined
    try {
      const { value } = await assign(core, runtime, task, {
        role: 'director',
        label: L(lang, `第${chapter.index}章 · 有声脚本`, `Ch. ${chapter.index} · audio script`),
        tool: 'submit_script',
        // The material is all in the task: a few looks at the book at most, then the result.
        maxSteps: 10,
        what: L(lang, '这一段的有声脚本：逐句的台词、旁白和声音提示', 'the audio script of this passage: its lines, narration and sound cues'),
        prompt: audioScriptTask({ lang, language: manifest.language, title: manifest.title, text: block, cast: castText, ambience: ambienceText, effects: sounds.effects, music: sounds.music }),
        temperature: 0.2,
        validate: (raw) => {
          const record = asRecord(raw)
          const parsed: DraftLine[] = []
          for (const entry of asArray(record.lines)) {
            const item = asRecord(entry)
            const content = asText(item.text)
            if (content === undefined) continue
            const kind = asText(item.kind)
            const speakerName = asText(item.speaker)
            const card = speakerName !== undefined ? resolve(speakerName) : undefined
            const direction = asText(item.direction)
            const lineKind: AudioLine['kind'] = kind === 'dialogue' || kind === 'thought' ? kind : 'narration'
            parsed.push({
              kind: lineKind,
              text: lineKind === 'narration' ? content : content.replace(/^["“「『]+|["”」』]+$/g, ''),
              ...(lineKind !== 'narration' && card !== undefined ? { speaker: card.id } : {}),
              ...(lineKind !== 'narration' && speakerName !== undefined ? { speakerName: card?.name ?? speakerName } : {}),
              ...(direction !== undefined ? { direction } : {}),
            })
          }
          if (parsed.length === 0) throw new Error('"lines" is empty')
          // The script must be the chapter, word for word; a director that paraphrases or stops early is told so and asked again.
          const covered = similarity(parsed.map(line => line.text).join(''), block)
          if (covered < 0.9) throw new Error(`the "text" of the lines covers only ${Math.round(covered * 100)}% of the passage — every word of the passage must appear in the lines, in order and unchanged`)
          const placed = asArray(record.cues).map(asRecord).map((cue): DraftCue | undefined => {
            const named = asText(cue.kind)
            const kind: SoundKind = named === 'effect' || named === 'music' ? named : 'bed'
            if ((kind === 'effect' && !sounds.effects) || (kind === 'music' && !sounds.music)) return undefined
            const preset = asText(cue.ambience) as AmbiencePreset | undefined
            const ambience: AmbiencePreset = kind === 'bed' && preset !== undefined && AMBIENCE_KEYS.includes(preset) ? preset : 'none'
            const at = Number(cue.at)
            const intensity = Number(cue.intensity)
            const caption = (asText(cue.caption) ?? asText(cue.note))?.replace(/^[\[〔（(♪\s]+|[\]〕）)\s]+$/gu, '').slice(0, 60)
            const prompt = asText(cue.prompt)?.slice(0, 400)
            if (!Number.isInteger(at) || at < 0 || at >= parsed.length) return undefined
            // A bed needs something to play — a preset the browser knows, or words a model can make it from; so does an effect or a piece of music.
            if (kind === 'bed' ? ambience === 'none' && preset !== 'none' && caption === undefined && prompt === undefined : caption === undefined && prompt === undefined) return undefined
            return {
              at,
              kind,
              ambience,
              ...(Number.isFinite(intensity) ? { intensity: Math.max(0, Math.min(1, intensity)) } : {}),
              ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
              ...(prompt !== undefined ? { prompt } : {}),
            }
          }).filter((cue): cue is DraftCue => cue !== undefined)
          return { lines: parsed, cues: placed }
        },
      })
      lines = value.lines
      cues = value.cues
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      reason = errorMessage(error)
      core.log(`audio script block for ${chapter.plan.id} fell back to the rule-based cut`, error)
    }
    done += 1
    task.job?.progress(done, blocks.length)
    return { lines: lines ?? fallbackLines(block), cues, ...(reason !== undefined ? { reason } : {}) }
  }, task.signal)

  // The passages are put back together before the takes are shaped, so narration runs on across the seams.
  const drafted: DraftLine[] = []
  const placed: DraftCue[] = []
  for (const block of results) {
    const offset = drafted.length
    drafted.push(...block.lines)
    for (const cue of block.cues) placed.push({ ...cue, at: offset + cue.at })
  }
  const tidy = tidyLines(drafted)
  const lines: AudioLine[] = tidy.lines.map((line, index) => ({ ...line, id: `l${index}` }))
  const cues: AudioCue[] = []
  for (const cue of placed) {
    const at = `l${tidy.map[cue.at] ?? 0}`
    const kind = cue.kind
    if (kind === 'bed') {
      // Consecutive passages often restate the same bed; only real changes become cues.
      const last = [...cues].reverse().find(item => (item.kind ?? 'bed') === 'bed')
      if (last !== undefined && (last.at === at || (last.ambience === cue.ambience && (cue.caption === undefined || cue.caption === last.caption)))) continue
    } else if (cues.some(item => item.kind === kind && item.at === at)) {
      continue
    }
    cues.push({
      id: `c${cues.length}`,
      at,
      kind,
      ambience: cue.ambience,
      ...(cue.intensity !== undefined ? { intensity: cue.intensity } : {}),
      ...(cue.caption !== undefined ? { caption: cue.caption } : {}),
      ...(cue.prompt !== undefined ? { prompt: cue.prompt } : {}),
    })
  }
  const firstBed = cues.find(cue => (cue.kind ?? 'bed') === 'bed')
  if (firstBed === undefined || firstBed.at !== 'l0') cues.unshift({ id: `c${cues.length}`, at: 'l0', kind: 'bed', ambience: firstBed?.ambience ?? 'none', intensity: 0.4 })
  if (existing !== undefined) {
    // Audio rendered for identical lines of the previous script is kept.
    const byText = new Map(existing.lines.filter(line => line.audio !== undefined).map(line => [`${line.kind}|${line.speaker ?? ''}|${line.speakerName ?? ''}|${line.text}|${line.direction ?? ''}`, line]))
    for (const line of lines) {
      const previous = byText.get(`${line.kind}|${line.speaker ?? ''}|${line.speakerName ?? ''}|${line.text}|${line.direction ?? ''}`)
      if (previous?.audio !== undefined) {
        line.audio = previous.audio
        if (previous.duration !== undefined) line.duration = previous.duration
        if (previous.renderKey !== undefined) line.renderKey = previous.renderKey
        if (previous.takes !== undefined) line.takes = previous.takes
        if (previous.check !== undefined) line.check = previous.check
      }
    }
    // So are the sounds already generated for cues that say the same thing.
    const made = new Map(existing.cues.filter(cue => cue.audio !== undefined).map(cue => [cueKey(cue), cue]))
    for (const cue of cues) {
      const previous = made.get(cueKey(cue))
      if (previous?.audio === undefined) continue
      cue.audio = previous.audio
      if (previous.duration !== undefined) cue.duration = previous.duration
      if (previous.renderKey !== undefined) cue.renderKey = previous.renderKey
    }
  }
  // A passage the director could not deliver is cut by rule, which knows no speakers: say so, the script must not look finished when it is not.
  const failed = results.filter(block => block.reason !== undefined)
  const script: AudioScript = {
    schema: 1,
    chapterId: chapter.plan.id,
    textHash,
    updatedAt: new Date().toISOString(),
    shape: SCRIPT_SHAPE,
    lines,
    cues,
    ...(failed.length > 0 ? { degraded: { blocks: failed.length, of: blocks.length, reason: failed[0]!.reason! } } : {}),
  }
  await project.saveAudioScript(script)
  return script
}

/**
 * Shape a script made before narration was spoken in whole takes, without
 * asking a model again: neighbouring narration is joined, stranded speech tags
 * are marked, cues follow their lines. Spoken lines that did not change keep
 * their audio; narration that was joined has to be spoken anew.
 */
export async function reshapeAudioScript(runtime: ProjectRuntime, chapterRef: string): Promise<{ script: AudioScript; before: number; after: number; kept: number }> {
  const { project } = runtime
  const located = await project.findChapter(chapterRef)
  const script = located !== undefined ? await project.audioScript(located.plan.id) : undefined
  if (script === undefined) throw new ProjectError('novel/not-found', 'this chapter has no audio script')
  const index = new Map(script.lines.map((line, at) => [line.id, at]))
  const tidy = tidyLines(script.lines.map(({ id: _id, skip: _skip, ...line }) => line))
  let kept = 0
  const lines: AudioLine[] = tidy.lines.map((line, at) => {
    // A line that went through untouched is the same recording; anything joined is new text.
    const sources = script.lines.filter((_source, from) => tidy.map[from] === at)
    const same = sources.length === 1 && sources[0]!.text === line.text
    if (same && line.audio !== undefined) kept += 1
    if (same) return { ...line, id: `l${at}` }
    const { audio: _audio, duration: _duration, renderKey: _renderKey, takes: _takes, check: _check, error: _error, ...rest } = line
    return { ...rest, id: `l${at}` }
  })
  const cues = script.cues.map((cue, at) => ({ ...cue, id: cue.id ?? `c${at}`, at: `l${tidy.map[index.get(cue.at) ?? 0] ?? 0}` }))
  const next: AudioScript = { ...script, shape: SCRIPT_SHAPE, updatedAt: new Date().toISOString(), lines, cues }
  await project.saveAudioScript(next)
  return { script: next, before: script.lines.length, after: lines.length, kept }
}

function castFor(chapter: LocatedChapter, characters: CharacterCard[], text: string): CharacterCard[] {
  const planned = new Set(chapter.plan.characters ?? [])
  return characters.filter(card => planned.has(card.id) || [card.name, ...(card.aliases ?? [])].some(name => name.length > 0 && text.includes(name)))
}

export interface VoiceChoice {
  voice?: string
  direction?: string
  /** Project-relative clip of a voice made for this speaker; providers that imitate a clip speak with it. */
  sample?: string
}

/** What a voice is known by in the voice sheet: the clip made for it, else its id or description, else "whatever the provider reads with". */
function voiceKey(choice: VoiceChoice): string {
  return choice.sample ?? choice.voice ?? '(default)'
}

// ───────────────────────────── the voice sheet ─────────────────────────────

/**
 * The book's casting, open for one piece of work. Voices picked for characters
 * and for speakers without a card are read from the sheet first, so a speaker
 * keeps one voice from chapter to chapter and from the audio drama to the
 * interludes; what is newly picked, and what is learned about how each voice
 * sounds, goes back into the sheet.
 */
export interface CastSession {
  /** Character id → voice. */
  readonly taken: Map<string, string>
  /** Speaker without a card, by name → voice. */
  readonly extras: Map<string, string>
  /** The usual pitch of a voice, when it is known well enough to judge a take by. */
  print(choice: VoiceChoice): number | undefined
  /** Record what a reference clip of the voice sounds like. */
  anchor(choice: VoiceChoice, clip: PcmAudio): void
  /** Learn from a clean, long take of a voice that has no reference clip. */
  learn(choice: VoiceChoice, measured: VoiceMeasure): void
  /** Write what changed back to the project. */
  save(): Promise<void>
}

function emptyCast(settings: TtsSettings): VoiceCast {
  return { schema: 1, provider: settings.provider, ...(settings.model !== undefined ? { model: settings.model } : {}), characters: {}, extras: {}, prints: {}, updatedAt: new Date().toISOString() }
}

/** A print learned from lines is trusted once it rests on this many of them. */
const PRINT_SAMPLES = 3

export async function openCast(project: Project, settings: TtsSettings): Promise<CastSession> {
  const stored = await project.voiceCast()
  // Voices belong to the speech setup that speaks them: another provider or model casts afresh.
  const sheet = stored !== undefined && stored.provider === settings.provider && (stored.model ?? '') === (settings.model ?? '') ? stored : emptyCast(settings)
  const taken = new Map(Object.entries(sheet.characters))
  const extras = new Map(Object.entries(sheet.extras))
  const prints = new Map<string, VoicePrint>(Object.entries(sheet.prints))
  let dirty = stored !== sheet
  const before = { characters: JSON.stringify(sheet.characters), extras: JSON.stringify(sheet.extras) }
  return {
    taken,
    extras,
    print(choice) {
      const print = prints.get(voiceKey(choice))
      return print !== undefined && (print.anchored === true || print.samples >= PRINT_SAMPLES) ? print.pitch : undefined
    },
    anchor(choice, clip) {
      const key = voiceKey(choice)
      if (prints.get(key)?.anchored === true) return
      const pitch = measure(clip).pitch
      if (pitch === undefined) return
      prints.set(key, { pitch: Math.round(pitch * 10) / 10, samples: 1, anchored: true })
      dirty = true
    },
    learn(choice, measured) {
      const key = voiceKey(choice)
      if (measured.pitch === undefined || measured.voiced < 1) return
      const known = prints.get(key)
      if (known?.anchored === true || (known !== undefined && known.samples >= 12)) return
      // A running mean on a log scale: pitch is heard in ratios.
      const samples = (known?.samples ?? 0) + 1
      const pitch = known === undefined ? measured.pitch : 2 ** ((Math.log2(known.pitch) * known.samples + Math.log2(measured.pitch)) / samples)
      prints.set(key, { pitch: Math.round(pitch * 10) / 10, samples })
      dirty = true
    },
    async save() {
      const characters = Object.fromEntries(taken)
      const others = Object.fromEntries(extras)
      if (!dirty && JSON.stringify(characters) === before.characters && JSON.stringify(others) === before.extras) return
      dirty = false
      before.characters = JSON.stringify(characters)
      before.extras = JSON.stringify(others)
      await project.updateVoiceCast(sheet, (current) => {
        // Another render may have cast in the meantime: its picks stay, ours are added.
        const base = current.provider === sheet.provider && (current.model ?? '') === (sheet.model ?? '') ? current : sheet
        return {
          ...base,
          characters: { ...base.characters, ...characters },
          extras: { ...base.extras, ...others },
          prints: { ...base.prints, ...Object.fromEntries(prints) },
          updatedAt: new Date().toISOString(),
        }
      })
    },
  }
}

/**
 * The voice each speaker has — or will get — in the audio drama, without
 * deciding anything: the sheet is read, not written. For showing the author
 * who sounds like whom before, and after, a chapter is voiced.
 * @param lines - whose voices to look up; every character with a card when left out.
 */
export async function previewVoices(project: Project, settings: TtsSettings, lines?: readonly Pick<AudioLine, 'kind' | 'speaker' | 'speakerName'>[]): Promise<{ characters: Record<string, string>; extras: Record<string, string> }> {
  const found = { characters: {} as Record<string, string>, extras: {} as Record<string, string> }
  if (settings.provider === 'none') return found
  const cast = await openCast(project, settings)
  // Copies: looking must not cast.
  const taken = new Map(cast.taken)
  const extras = new Map(cast.extras)
  const characters = await project.characters()
  const speakers: Pick<AudioLine, 'kind' | 'speaker' | 'speakerName'>[] = lines !== undefined
    ? lines.filter(line => line.kind !== 'narration' && (line.speaker !== undefined || line.speakerName !== undefined))
    : characters.map(card => ({ kind: 'dialogue' as const, speaker: card.id, speakerName: card.name }))
  for (const line of speakers) {
    const known = line.speaker !== undefined && characters.some(card => card.id === line.speaker)
    const name = (line.speakerName ?? '').trim()
    if (known ? found.characters[line.speaker!] !== undefined : name.length === 0 || found.extras[name] !== undefined) continue
    const voice = voiceFor(line, characters, settings, taken, extras).voice
    if (voice === undefined) continue
    if (known) found.characters[line.speaker!] = voice
    else found.extras[name] = voice
  }
  return found
}

/** Decide which voice speaks a line and with what delivery. */
export function voiceFor(line: Pick<AudioLine, 'kind' | 'speaker' | 'speakerName' | 'direction'>, characters: CharacterCard[], settings: TtsSettings, taken: Map<string, string>, extras: Map<string, string> = new Map()): VoiceChoice {
  const join = (...parts: (string | undefined)[]): string | undefined => {
    const text = parts.filter((part): part is string => part !== undefined && part.trim().length > 0).join('；')
    return text.length > 0 ? text : undefined
  }
  const inWords = describesVoices(settings.provider)
  const narrator = settings.narratorVoice ?? (inWords ? AUDIOGEN_NARRATOR : undefined)
  if (line.kind === 'narration' || (line.speaker === undefined && line.speakerName === undefined)) {
    const direction = join(settings.narratorInstructions, line.direction)
    return { ...(narrator !== undefined ? { voice: narrator } : {}), ...(direction !== undefined ? { direction } : {}) }
  }
  const card = characters.find(candidate => candidate.id === line.speaker)
  const who = card !== undefined
    ? `${card.name}${card.gender !== undefined ? `，${card.gender}` : ''}${card.age !== undefined ? `，${card.age}` : ''}${card.voice !== undefined ? `，${card.voice}` : ''}`
    : line.speakerName
  const inner = line.kind === 'thought' ? '内心独白，轻声、贴近耳边' : undefined
  // The narrator's voice is spoken for, also when it is only the provider's default.
  const telling = narrator ?? providerDefaultVoice(settings.provider)
  const inUse = (): Set<string> => new Set([...taken.values(), ...extras.values(), ...(telling !== undefined ? [telling] : [])])
  let voice: string | undefined
  if (card !== undefined) {
    const profile = card.voiceProfile
    const own = profile?.voice !== undefined && (profile.provider === undefined || profile.provider === settings.provider)
    if (own) voice = profile.voice
    else {
      // Where voices are words, what the card says of the voice is the casting, and follows the card when it changes.
      const described = inWords ? describeVoice(card) : undefined
      voice = described ?? taken.get(card.id) ?? castVoice(card, settings.provider, inUse(), settings.model)
      if (described === undefined && voice !== undefined) taken.set(card.id, voice)
    }
    // Where the voice itself is a description, who is speaking is already said.
    const direction = join(!inWords && who !== undefined ? `角色：${who}` : undefined, profile?.instructions, inner, line.direction)
    return {
      ...(voice !== undefined ? { voice } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(own && profile.sample !== undefined ? { sample: profile.sample } : {}),
    }
  }
  // A speaker without a card still has a voice of their own: not the narrator's, and not the next stranger's.
  const name = (line.speakerName ?? '').trim()
  voice = extras.get(name)
  if (voice === undefined) {
    const gender = guessGender({ gender: name })
    const configured = settings.defaultVoices?.[gender]
    const pool = stockVoices(settings.provider, settings.model).filter(candidate => candidate.accent === undefined && candidate.age !== 'child' && (gender === 'neutral' || candidate.gender === gender))
    const used = inUse()
    const free = pool.filter(candidate => !used.has(candidate.id))
    const from = free.length > 0 ? free : pool
    voice = configured !== undefined && !used.has(configured) ? configured : from.length > 0 ? from[parseInt(hashText(name).slice(0, 6), 16) % from.length]!.id : configured
    if (voice !== undefined && name.length > 0) extras.set(name, voice)
  }
  const direction = join(!inWords && who !== undefined ? `角色：${who}` : undefined, inner, line.direction)
  return { ...(voice !== undefined ? { voice } : {}), ...(direction !== undefined ? { direction } : {}) }
}

/**
 * Reference clips for providers whose voices are words. Each described voice
 * gets one clip, made the first time it is needed and kept in the project;
 * every later line imitates the clip, so a character keeps one voice for the
 * whole book. Providers with voice ids need none of this.
 */
export interface VoiceBank {
  (choice: VoiceChoice): Promise<PcmAudio | undefined>
  /** The clip of a voice when the project already holds one; never makes one. */
  kept(choice: VoiceChoice): Promise<PcmAudio | undefined>
}

export function voiceBank(core: NovelCore, runtime: ProjectRuntime, provider: TtsProvider, settings: TtsSettings, language: string, signal?: AbortSignal, onAnchor?: (voice: string, phase: 'start' | 'end') => void, cast?: CastSession): VoiceBank {
  const { project } = runtime
  const clips = new Map<string, Promise<PcmAudio | undefined>>()
  const load = async (relative: string): Promise<PcmAudio | undefined> => {
    try {
      return parseWav(await project.readFile(relative))
    } catch {
      return undefined
    }
  }
  const anchorPath = (voice: string): string => `audio/voices/anchor-${hashText([settings.model ?? '', voice].join('|')).slice(0, 12)}.wav`
  const kept = async (choice: VoiceChoice): Promise<PcmAudio | undefined> => {
    if (provider.anchor === undefined) return undefined
    const designed = choice.sample !== undefined ? await load(choice.sample) : undefined
    const clip = designed ?? (choice.voice !== undefined ? await load(`assets/${anchorPath(choice.voice)}`) : undefined)
    if (clip !== undefined) cast?.anchor(choice, clip)
    return clip
  }
  const bank = async (choice: VoiceChoice): Promise<PcmAudio | undefined> => {
    if (provider.anchor === undefined || (choice.sample === undefined && choice.voice === undefined)) return undefined
    const key = voiceKey(choice)
    let pending = clips.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const held = await kept(choice)
        if (held !== undefined || choice.voice === undefined) return held
        const voice = choice.voice
        // Another chapter may be making this very clip: one voice, one clip, whoever asked first.
        const shared = `${project.root}|${anchorPath(voice)}`
        const underway = anchoring.get(shared)
        // The first line of a voice waits for this clip, which can take as long as a line: say so rather than sit silent.
        onAnchor?.(voice, 'start')
        try {
          if (underway !== undefined) {
            const clip = await underway
            if (clip !== undefined) cast?.anchor(choice, clip)
            return clip
          }
          const making = (async () => {
            const clip = leveled(trimSilence(await provider.anchor!(voice, { language, ...(signal !== undefined ? { signal } : {}) })))
            await project.writeAsset(anchorPath(voice), encodeWav(clip))
            return clip
          })()
          const tracked = making.catch(() => undefined)
          anchoring.set(shared, tracked)
          void tracked.then(() => { if (anchoring.get(shared) === tracked) anchoring.delete(shared) })
          const clip = await making
          cast?.anchor(choice, clip)
          return clip
        } catch (error) {
          if (signal?.aborted === true) throw error
          // Without a clip the line is still spoken from the description; it is only less steady.
          core.log(`could not make a reference clip for "${voice.slice(0, 40)}"`, error)
          return undefined
        } finally {
          onAnchor?.(voice, 'end')
        }
      })()
      clips.set(key, pending)
    }
    return await pending
  }
  return Object.assign(bank, { kept })
}

/** The synthesis request for a line once its voice is decided. */
export async function speechRequest(choice: VoiceChoice, text: string, language: string, reference: (choice: VoiceChoice) => Promise<PcmAudio | undefined>, signal?: AbortSignal): Promise<TtsRequest> {
  const clip = await reference(choice)
  return {
    text,
    ...(choice.voice !== undefined ? { voice: choice.voice } : {}),
    ...(choice.direction !== undefined ? { direction: choice.direction } : {}),
    ...(clip !== undefined ? { reference: clip } : {}),
    language,
    ...(signal !== undefined ? { signal } : {}),
  }
}

/** How many more takes a line gets when the first does not pass, unless the settings say otherwise. */
const DEFAULT_RETAKES = 2

export function retakesOf(settings: TtsSettings): number {
  const wanted = settings.retakes
  return wanted !== undefined && Number.isFinite(wanted) ? Math.max(0, Math.min(4, Math.round(wanted))) : DEFAULT_RETAKES
}

export interface Take {
  /** The kept take, trimmed and brought to the common level. */
  audio: PcmAudio
  measured: VoiceMeasure
  verdict: TakeVerdict
  /** How many times the line was spoken. */
  takes: number
}

/**
 * Speak a line and listen to it. A take that is silent, cut short, padded, or
 * — where the voice's usual pitch is known — plainly someone else's voice is
 * spoken again, up to `retakes` more times; the best take is kept either way,
 * and its verdict says what is still wrong with it.
 */
export async function speakChecked(provider: TtsProvider, request: TtsRequest, options: { print?: number | undefined; retakes: number; onRetake?: (take: number, issues: TakeIssue[]) => void }): Promise<Take> {
  let best: Take | undefined
  for (let take = 0; take <= options.retakes; take++) {
    let audio: PcmAudio
    try {
      audio = trimSilence(await provider.synthesize(take === 0 ? request : { ...request, take }))
    } catch (error) {
      // A retake that fails outright does not cost the line the take it already has.
      if (best === undefined || request.signal?.aborted === true) throw error
      break
    }
    const measured = measure(audio)
    const verdict = judge(measured, request.text, options.print)
    if (best === undefined || badness(verdict) < badness(best.verdict)) best = { audio, measured, verdict, takes: take + 1 }
    else best = { ...best, takes: take + 1 }
    if (verdict.issues.length === 0) break
    if (take < options.retakes) options.onRetake?.(take + 1, verdict.issues)
  }
  return { ...best!, audio: leveled(best!.audio, best!.measured) }
}

export interface SynthesisResult {
  chapterId: string
  lines: number
  rendered: number
  cached: number
  failed: number
  /** Total spoken duration in seconds. */
  duration: number
  /** Lines that were spoken more than once before a take was kept. */
  retaken: number
  /** Lines whose kept take the listening check still faults. */
  flagged: number
  /** Lines rendered earlier that did not pass the check and were spoken again. */
  rechecked: number
  /** Lines rendered earlier that only needed bringing to the common level. */
  leveled: number
}

const ISSUE_WORDS: Record<TakeIssue, [string, string]> = {
  silent: ['没有声音', 'silent'],
  short: ['没念完', 'cut short'],
  long: ['念多了', 'too long'],
  drift: ['不像这个声音', 'not this voice'],
}

/** Render every line of a chapter's script that has no current audio. */
export async function synthesizeChapter(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; lines?: string[]; force?: boolean }, task: TaskContext): Promise<SynthesisResult> {
  const { project } = runtime
  const provider = await requireSpeech(core, runtime)
  const settings = (await core.settings.get()).tts
  let script = await buildAudioScript(core, runtime, { chapter: params.chapter }, task)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const retakes = retakesOf(settings)
  let rendered = 0
  let failed = 0
  let done = 0
  let total = 0
  let retaken = 0
  let flagged = 0
  let evened = 0
  // What is being worked on right now: a long render says which lines are in the booth and when a voice is being set up.
  const speaking = new Map<string, string>()
  // Lines of this run that have not reached the booth yet.
  const waiting = new Set<string>()
  let tuning = 0
  let note: string | undefined
  const report = (): void => {
    const now = [...speaking.values()].at(-1)
    const label = tuning > 0
      ? L(lang, '正在为新出场的声音定音色（只做一次，之后全书沿用）', 'setting up a new voice (once; the book keeps it)')
      : note ?? (now !== undefined ? L(lang, `正在念：${now}`, `speaking: ${now}`) : L(lang, '合成语音', 'synthesizing'))
    task.job?.progress(done, total, label)
    task.job?.result({ chapterId: script.chapterId, active: [...speaking.keys()], waiting: [...waiting], rendered, failed, retaken, flagged })
  }
  // Resolve voices in script order first so casting does not depend on which request finishes first.
  // Lines left unspoken — speech tags, or whatever the author silenced — never reach the booth.
  // The sheet is read, cast from and written back in one go: chapters voiced side by side cast one after the other.
  const { cast, plan } = await castLocks.run(project.root, async () => {
    const cast = await openCast(project, settings)
    const plan = script.lines.filter(line => !isSkipped(line, settings)).map((line) => {
      const choice = voiceFor(line, characters, settings, cast.taken, cast.extras)
      const renderKey = hashText([settings.provider, settings.model ?? '', choice.voice ?? '', choice.direction ?? '', line.text].join('|'))
      return { line, choice, renderKey }
    })
    // What was just cast is kept before the first word is spoken: a render that is stopped has still decided who sounds like whom.
    await cast.save()
    return { cast, plan }
  })
  const reference = voiceBank(core, runtime, provider, settings, manifest.language, task.signal, (_voice, phase) => {
    tuning += phase === 'start' ? 1 : -1
    report()
  }, cast)
  const wanted = params.lines !== undefined ? new Set(params.lines) : undefined
  const stale = (item: typeof plan[number]): boolean => params.force === true || item.line.audio === undefined || item.line.renderKey !== item.renderKey
  const todo = plan.filter(item => (wanted === undefined || wanted.has(item.line.id)) && stale(item))
  const updates = new Map<string, Partial<AudioLine>>()

  // Lines rendered before are listened to again: the ones that do not pass are spoken again, the rest only evened out.
  const again = new Set<string>()
  if (wanted === undefined && params.force !== true) {
    task.job?.progress(0, 0, L(lang, '听检已有的配音…', 'checking the lines already voiced…'))
    for (const item of plan) {
      if (stale(item) || item.line.audio === undefined) continue
      // A line that has had its retakes and still stands out is the author's to decide.
      if (item.line.check !== undefined && (item.line.takes ?? 1) > retakes) continue
      let audio: PcmAudio
      try {
        audio = parseWav(await project.readFile(item.line.audio))
      } catch {
        todo.push(item)
        again.add(item.line.id)
        continue
      }
      await reference.kept(item.choice)
      const measured = measure(audio)
      const verdict = judge(measured, item.line.text, cast.print(item.choice))
      if (verdict.issues.length > 0 && retakes > 0) {
        todo.push(item)
        again.add(item.line.id)
      } else if (verdict.issues.length > 0) {
        if (item.line.check === undefined) updates.set(item.line.id, { check: verdict.issues })
      } else if (Math.abs(measured.level - TARGET_LEVEL) > 1.5 && measured.speech >= 0.05) {
        const even = leveled(audio, measured)
        if (even !== audio) {
          await project.writeAsset(item.line.audio.replace(/^assets\//, ''), encodeWav(even))
          evened += 1
        }
      }
    }
    todo.sort((left, right) => script.lines.indexOf(left.line) - script.lines.indexOf(right.line))
    if (again.size > 0) note = L(lang, `有 ${again.size} 句旧配音没通过听检（没念完，或不像原来的声音），正在重念`, `${again.size} earlier lines did not pass the check (cut short, or not in their voice) and are being spoken again`)
  }

  total = todo.length
  for (const item of todo) waiting.add(item.line.id)
  const who = (line: AudioLine): string => line.kind === 'narration' ? L(lang, '旁白', 'narrator') : line.speakerName ?? characters.find(card => card.id === line.speaker)?.name ?? L(lang, '角色', 'a character')
  report()
  let lastSave = Date.now()
  const inOrder = serializer()
  const flush = (): Promise<void> => inOrder(async () => {
    if (updates.size === 0) return
    lastSave = Date.now()
    const pending = new Map(updates)
    updates.clear()
    // Onto the script as it stands now: sounds made and lines edited meanwhile are not this run's to overwrite.
    const saved = await changeScript(project, script.chapterId, current => ({
      ...current,
      lines: current.lines.map(line => pending.has(line.id) ? stripUnset({ ...line, ...pending.get(line.id) }) : line),
      updatedAt: new Date().toISOString(),
    }))
    if (saved !== undefined) script = saved
  })
  // As many lines wait at the booth door as may be inside at once; the gate behind it counts over every chapter being voiced.
  await mapLimit(todo, core.parallel('speech'), async ({ line, choice, renderKey }) => {
    const label = `${who(line)}「${clipText(line.text, 16, '…')}」`
    // In the booth from the moment the line is actually sent, not from when it joined the queue.
    const enter = (): void => {
      waiting.delete(line.id)
      if (!speaking.has(line.id)) speaking.set(line.id, label)
      report()
    }
    try {
      const request = { ...await speechRequest(choice, line.text, manifest.language, reference, task.signal), onStart: enter }
      const take = await speakChecked(provider, request, {
        print: cast.print(choice),
        retakes,
        onRetake: (number, issues) => {
          speaking.set(line.id, L(lang, `${label}（${issues.map(issue => ISSUE_WORDS[issue][0]).join('、')}，重念第 ${number} 次）`, `${label} (${issues.map(issue => ISSUE_WORDS[issue][1]).join(', ')}: take ${number + 1})`))
          report()
        },
      })
      // A voice without a reference clip is learned from its clean, long lines.
      if (take.verdict.issues.length === 0 && speechUnits(line.text) >= 12) cast.learn(choice, take.measured)
      const path = await project.writeAsset(`audio/${script.chapterId}/${line.id}-${renderKey.slice(0, 8)}.wav`, encodeWav(take.audio))
      updates.set(line.id, {
        audio: path,
        duration: Number(durationOf(take.audio).toFixed(2)),
        renderKey,
        error: undefined,
        takes: take.takes > 1 ? take.takes : undefined,
        check: take.verdict.issues.length > 0 ? take.verdict.issues : undefined,
      })
      rendered += 1
      if (take.takes > 1) retaken += 1
      if (take.verdict.issues.length > 0) flagged += 1
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      updates.set(line.id, { error: error instanceof Error ? error.message : String(error) })
      failed += 1
    } finally {
      waiting.delete(line.id)
      speaking.delete(line.id)
    }
    done += 1
    report()
    // Persist as we go so a long render can be listened to (and resumed) before it finishes.
    if (Date.now() - lastSave > 4000) await flush()
  }, task.signal).finally(async () => {
    await flush()
    await cast.save().catch((error: unknown) => { core.log('could not save the voice sheet', error) })
  })
  const duration = script.lines.reduce((sum, line) => sum + (line.duration ?? 0), 0)
  task.job?.result({ chapterId: script.chapterId, active: [], waiting: [], rendered, failed, retaken, flagged })
  return {
    chapterId: script.chapterId,
    lines: script.lines.length,
    rendered,
    cached: plan.length - todo.length,
    failed,
    duration: Number(duration.toFixed(1)),
    retaken,
    flagged,
    rechecked: again.size,
    leveled: evened,
  }
}

/** Drop the fields an update cleared by setting them to undefined. */
function stripUnset(line: AudioLine): AudioLine {
  const out = { ...line } as Record<string, unknown>
  for (const key of ['error', 'takes', 'check'] as const) if (out[key] === undefined) delete out[key]
  return out as unknown as AudioLine
}

/** Join a chapter's rendered lines into one WAV file under `assets/audio/`. */
export async function exportChapterAudio(runtime: ProjectRuntime, chapterRef: string, settings: Pick<TtsSettings, 'speechTags'> = {}): Promise<{ path: string; duration: number; missing: number }> {
  const { project } = runtime
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const script = await project.audioScript(chapter.plan.id)
  if (script === undefined) throw new ProjectError('novel/empty', 'this chapter has no audio script yet')
  const segments: { audio: PcmAudio; gapSeconds: number }[] = []
  let missing = 0
  for (const line of script.lines) {
    if (isSkipped(line, settings)) continue
    if (line.audio === undefined) {
      missing += 1
      continue
    }
    try {
      const audio = parseWav(await project.readFile(line.audio))
      segments.push({ audio, gapSeconds: line.kind === 'narration' ? 0.45 : 0.3 })
    } catch {
      missing += 1
    }
  }
  if (segments.length === 0) throw new ProjectError('novel/empty', 'no line of this chapter has been synthesized yet')
  const mixed = concatAudio(segments)
  const path = await project.writeAsset(`audio/${chapter.plan.id}.wav`, encodeWav(mixed))
  return { path, duration: Number(durationOf(mixed).toFixed(1)), missing }
}

/**
 * Speak a sample so a voice can be judged by ear: a voice named outright, the
 * voice a character speaks with in the audio drama (whatever was cast for them
 * when their card names none), or the narrator's.
 * @returns the project-relative path of the sample.
 */
export async function audition(core: NovelCore, runtime: ProjectRuntime, params: { voice?: string; character?: string; text: string; direction?: string }, task: TaskContext): Promise<{ path: string; duration: number }> {
  const provider = await requireSpeech(core, runtime)
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const settings = (await core.settings.get()).tts
  const cast = await openCast(runtime.project, settings)
  // No voice named: the narrator's, which is what a line without a speaker is read in.
  const narrator = settings.narratorVoice ?? (describesVoices(settings.provider) ? AUDIOGEN_NARRATOR : undefined)
  const card = params.voice === undefined && params.character !== undefined ? await runtime.project.findCharacter(params.character) : undefined
  // A character is heard exactly as a line of theirs would be: same casting, same baseline delivery.
  const choice: VoiceChoice = card !== undefined
    ? voiceFor({ kind: 'dialogue', speaker: card.id, speakerName: card.name, ...(params.direction !== undefined ? { direction: params.direction } : {}) }, await runtime.project.characters(), settings, cast.taken, cast.extras)
    : { ...((params.voice ?? narrator) !== undefined ? { voice: (params.voice ?? narrator)! } : {}), ...(params.direction !== undefined ? { direction: params.direction } : {}) }
  const voice = choice.voice
  task.job?.progress(0, 2, L(lang, '准备声音…', 'getting the voice ready…'))
  const reference = voiceBank(core, runtime, provider, settings, manifest.language, task.signal, (_voice, phase) => {
    if (phase === 'start') task.job?.progress(0, 2, L(lang, '这个声音第一次用，先给它定音色（只做一次）…', 'first use of this voice: setting it up (once)…'))
  }, cast)
  const text = params.text.slice(0, 300)
  const request = await speechRequest(choice, text, manifest.language, reference, task.signal)
  task.job?.progress(1, 2, L(lang, '正在生成试听语音…', 'speaking the sample…'))
  const take = await speakChecked(provider, request, { print: cast.print(choice), retakes: Math.min(1, retakesOf(settings)) })
  const key = hashText([voice ?? '', params.direction ?? '', params.text].join('|')).slice(0, 10)
  const path = await runtime.project.writeAsset(`audio/auditions/${key}.wav`, encodeWav(take.audio))
  await cast.save().catch(() => {})
  task.job?.progress(2, 2)
  return { path, duration: Number(durationOf(take.audio).toFixed(2)) }
}

/** Create a voice of their own for a character from their persona, and store it on the card. */
export async function designCharacterVoice(core: NovelCore, runtime: ProjectRuntime, params: { character: string; prompt?: string; previewText?: string }, task: TaskContext): Promise<{ character: string; voice: string; sample?: string }> {
  const { project } = runtime
  const provider = await requireSpeech(core, runtime)
  if (provider.designVoice === undefined) {
    throw new ProviderError('the configured speech provider cannot design voices — switch to Bailian audio generation or Qwen TTS, or pick a stock voice for the character', undefined, 'UNSUPPORTED')
  }
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const manifest = await project.manifest()
  const zh = promptLanguage(manifest.language) === 'zh'
  const prompt = params.prompt ?? card.voiceProfile?.designPrompt ?? [
    card.gender, card.age !== undefined ? (zh ? `${card.age}` : `aged ${card.age}`) : undefined, card.voice, card.personality,
  ].filter((part): part is string => part !== undefined && part.length > 0).join(zh ? '，' : ', ')
  if (prompt.trim().length === 0) throw new ProjectError('novel/invalid', `${card.name} has no gender, age, voice or personality to design a voice from`)
  const memories = await project.memories()
  const quote = memories.flatMap(entry => entry.memory.characters).find(moment => moment.character === card.id && moment.quote !== undefined)?.quote
  const previewText = params.previewText ?? quote ?? (zh ? '我说过的话，从来不会收回。你要是不信，尽管试试看。' : 'I never take back what I have said. Try me, if you doubt it.')
  const designed = await provider.designVoice({
    prompt,
    previewText,
    name: card.id.replace(/[^A-Za-z0-9]/g, '') || `c${hashText(card.id).slice(0, 6)}`,
    language: manifest.language,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  let sample: string | undefined
  if (designed.preview !== undefined) sample = await project.writeAsset(`audio/voices/${card.id}-${hashText(designed.voice).slice(0, 6)}.wav`, encodeWav(designed.preview))
  await project.saveCharacter({
    id: card.id,
    voiceProfile: { ...card.voiceProfile, provider: provider.kind, voice: designed.voice, designPrompt: prompt, ...(sample !== undefined ? { sample } : {}) },
  })
  return { character: card.id, voice: designed.voice, ...(sample !== undefined ? { sample } : {}) }
}

/** Change one line of a chapter's script by hand; a changed line re-renders on the next synthesis. */
export async function updateAudioLine(runtime: ProjectRuntime, chapterRef: string, lineId: string, patch: Partial<Pick<AudioLine, 'text' | 'kind' | 'speaker' | 'speakerName' | 'direction'>> & { voiced?: boolean | null }): Promise<AudioScript> {
  const { project } = runtime
  const located = await project.findChapter(chapterRef)
  const script = located !== undefined ? await project.audioScript(located.plan.id) : undefined
  if (script === undefined) throw new ProjectError('novel/not-found', 'this chapter has no audio script')
  if (!script.lines.some(entry => entry.id === lineId)) throw new ProjectError('novel/not-found', `the script has no line "${lineId}"`)
  const characters = await project.characters()
  const next: AudioScript = {
    ...script,
    updatedAt: new Date().toISOString(),
    lines: script.lines.map((entry) => {
      if (entry.id !== lineId) return entry
      const { voiced, ...fields } = patch
      const merged: AudioLine = { ...entry, ...fields }
      // `null` hands the line back to the book's own rule for speech tags.
      if (voiced === null) delete merged.voiced
      else if (voiced !== undefined) merged.voiced = voiced
      delete merged.skip
      if (patch.speaker !== undefined) {
        const card = characters.find(candidate => candidate.id === patch.speaker)
        if (patch.speaker === '') {
          delete merged.speaker
          delete merged.speakerName
        } else if (card !== undefined) merged.speakerName = card.name
      }
      if (merged.direction === '') delete merged.direction
      return merged
    }),
  }
  await project.saveAudioScript(next)
  return next
}

/**
 * Take one line out of a chapter's audio script. Sound cues that began at it
 * move to the line after it (the one before, at the end of the script), and a
 * storyboard panel that showed it lets it go — a panel left with no line goes
 * with it.
 */
export async function removeAudioLine(runtime: ProjectRuntime, chapterRef: string, lineId: string): Promise<{ script: AudioScript; panels: number }> {
  const { project } = runtime
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const script = await project.audioScript(chapter.plan.id)
  if (script === undefined) throw new ProjectError('novel/empty', 'this chapter has no audio script yet')
  const at = script.lines.findIndex(line => line.id === lineId)
  if (at < 0) throw new ProjectError('novel/not-found', `the script has no line "${lineId}"`)
  const heir = script.lines[at + 1]?.id ?? script.lines[at - 1]?.id
  const next: AudioScript = {
    ...script,
    updatedAt: new Date().toISOString(),
    lines: script.lines.filter(line => line.id !== lineId),
    // A cue is where a sound begins: without its line it begins at the next thing said.
    cues: script.cues.flatMap(cue => cue.at !== lineId ? [cue] : heir !== undefined ? [{ ...cue, at: heir }] : []),
  }
  await project.saveAudioScript(next)
  let panels = 0
  const board = await project.comicBoard(chapter.plan.id)
  if (board !== undefined && board.panels.some(panel => panel.lines.includes(lineId))) {
    const kept = board.panels.map(panel => ({ ...panel, lines: panel.lines.filter(id => id !== lineId) })).filter(panel => panel.lines.length > 0)
    panels = board.panels.length - kept.length
    await project.saveComicBoard({ ...board, updatedAt: new Date().toISOString(), panels: kept })
  }
  return { script: next, panels }
}

/** Throw a chapter's audio script away. The takes already spoken stay on disk; a script directed again reuses the ones whose lines come back unchanged. */
export async function clearAudioScript(runtime: ProjectRuntime, chapterRef: string): Promise<{ chapterId: string; removed: boolean }> {
  const chapter = await runtime.project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  return { chapterId: chapter.plan.id, removed: await runtime.project.removeAudioScript(chapter.plan.id) }
}

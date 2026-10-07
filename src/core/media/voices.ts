// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Stock voice catalogs. They only seed casting and pickers — any voice id the
 * endpoint accepts can be typed in, and designed voices are added per project.
 * Attributes are best-effort descriptions; audition before trusting them.
 */
import type { CharacterCard, TtsProviderKind } from '../../shared/types'
import { hashText } from '../../shared/text'

export type VoiceGender = 'female' | 'male' | 'neutral'
export type VoiceAge = 'child' | 'young' | 'adult' | 'elder'

export interface VoiceInfo {
  id: string
  gender: VoiceGender
  age: VoiceAge
  /** Short description of the timbre or character. */
  note: string
  /** Set for voices with a marked accent or non-Mandarin language. */
  accent?: string
}

const v = (id: string, gender: VoiceGender, age: VoiceAge, note: string, accent?: string): VoiceInfo => ({ id, gender, age, note, ...(accent !== undefined ? { accent } : {}) })

/** Voices accepted by the Qwen omni realtime models (verified against qwen3.8-omni-flash-realtime). */
const QWEN_REALTIME: VoiceInfo[] = [
  v('Tina', 'female', 'young', '清亮自然的年轻女声'),
  v('Cindy', 'female', 'young', '明快亲切的女声'),
  v('Serena', 'female', 'adult', '温柔沉静的女声'),
  v('Maia', 'female', 'adult', '知性而温和的女声'),
  v('Katerina', 'female', 'adult', '成熟、有韵律感的御姐音'),
  v('Momo', 'female', 'young', '俏皮活泼的少女音'),
  v('Mia', 'female', 'young', '乖巧温软的女声'),
  v('Jennifer', 'female', 'adult', '电影感的美式女声', 'en-US'),
  v('Ryan', 'male', 'young', '节奏感强、戏感足的男声'),
  v('Andre', 'male', 'adult', '磁性沉稳的男声'),
  v('Aiden', 'male', 'young', '阳光的美式青年男声', 'en-US'),
  v('Dylan', 'male', 'young', '京腔少年', '北京话'),
  v('Li', 'male', 'adult', '耐心平和的中年男声', '南京话'),
  v('Marcus', 'male', 'adult', '浑厚朴实的男声', '陕西话'),
  v('Peter', 'male', 'adult', '逗趣的相声腔男声', '天津话'),
  v('Eric', 'male', 'young', '跳脱市井的男声', '四川话'),
  v('Sunny', 'female', 'young', '甜而泼辣的女声', '四川话'),
  v('Rocky', 'male', 'adult', '幽默风趣的男声', '粤语'),
  v('Kiki', 'female', 'young', '甜美的女声', '粤语'),
  v('Sohee', 'female', 'young', '温柔开朗的女声', 'ko'),
  v('Lenn', 'male', 'young', '理性的青年男声', 'de'),
  v('Emilien', 'male', 'adult', '浪漫的男声', 'fr'),
  v('Bodega', 'male', 'adult', '热情的大叔音', 'es'),
  v('Sonrisa', 'female', 'adult', '热情开朗的女声', 'es'),
  v('Alek', 'male', 'adult', '冷峻的男声', 'ru'),
  v('Dolce', 'male', 'adult', '慵懒的男声', 'it'),
]

/** Stock voices of the DashScope Qwen-TTS family. */
const QWEN_TTS: VoiceInfo[] = [
  v('Cherry', 'female', 'young', '阳光亲切的年轻女声'),
  v('Serena', 'female', 'adult', '温柔沉静的女声'),
  v('Chelsie', 'female', 'young', '二次元少女音'),
  v('Momo', 'female', 'young', '俏皮活泼的少女音'),
  v('Vivian', 'female', 'young', '拽而可爱的女声'),
  v('Maia', 'female', 'adult', '知性而温和的女声'),
  v('Katerina', 'female', 'adult', '成熟、有韵律感的御姐音'),
  v('Bellona', 'female', 'adult', '洪亮清晰、江湖气的女声'),
  v('Elias', 'female', 'adult', '严谨的讲述型女声'),
  v('Seren', 'female', 'adult', '舒缓助眠的女声'),
  v('Stella', 'female', 'young', '甜而元气的少女音'),
  v('Nini', 'female', 'young', '软糯的邻家妹妹'),
  v('Mia', 'female', 'young', '乖巧温软的女声'),
  v('Ebona', 'female', 'elder', '低沉诡秘的老妇声'),
  v('Bella', 'female', 'child', '小女孩'),
  v('Bunny', 'female', 'child', '萌系小女孩'),
  v('Ethan', 'male', 'young', '阳光温暖的青年男声'),
  v('Moon', 'male', 'young', '清冷帅气的男声'),
  v('Kai', 'male', 'adult', '耳朵 SPA 般的低音'),
  v('Nofish', 'male', 'adult', '不卷舌的设计师男声'),
  v('Ryan', 'male', 'young', '节奏感强、戏感足的男声'),
  v('Neil', 'male', 'adult', '字正腔圆的播音腔'),
  v('Vincent', 'male', 'adult', '沙哑烟嗓，江湖豪气'),
  v('Andre', 'male', 'adult', '磁性沉稳的男声'),
  v('Arthur', 'male', 'elder', '质朴的老人声，像讲故事的老大爷'),
  v('Eldric Sage', 'male', 'elder', '沉稳睿智的老者'),
  v('Mochi', 'male', 'child', '聪明的小男孩'),
  v('Pip', 'male', 'child', '调皮的小男孩'),
  v('Dylan', 'male', 'young', '京腔少年', '北京话'),
  v('Jada', 'female', 'adult', '风风火火的沪上阿姐', '上海话'),
  v('Sunny', 'female', 'young', '甜而泼辣的女声', '四川话'),
  v('Kiki', 'female', 'young', '甜美的女声', '粤语'),
  v('Rocky', 'male', 'adult', '幽默风趣的男声', '粤语'),
  v('Jennifer', 'female', 'adult', '电影感的美式女声', 'en-US'),
  v('Aiden', 'male', 'young', '阳光的美式青年男声', 'en-US'),
]

const OPENAI: VoiceInfo[] = [
  v('alloy', 'neutral', 'adult', 'balanced, neutral'),
  v('ash', 'male', 'adult', 'warm, grounded'),
  v('ballad', 'male', 'young', 'soft, expressive'),
  v('coral', 'female', 'young', 'bright, friendly'),
  v('echo', 'male', 'adult', 'calm, even'),
  v('fable', 'neutral', 'adult', 'storyteller'),
  v('nova', 'female', 'young', 'energetic'),
  v('onyx', 'male', 'adult', 'deep, authoritative'),
  v('sage', 'female', 'adult', 'composed'),
  v('shimmer', 'female', 'adult', 'gentle'),
  v('verse', 'male', 'young', 'versatile, lively'),
]

/** Gemini TTS voices (served by OpenRouter and other gateways); they speak any language. */
const GEMINI: VoiceInfo[] = [
  v('Zephyr', 'female', 'young', 'bright'),
  v('Leda', 'female', 'young', 'youthful'),
  v('Aoede', 'female', 'young', 'breezy'),
  v('Autonoe', 'female', 'young', 'bright'),
  v('Laomedeia', 'female', 'young', 'upbeat'),
  v('Kore', 'female', 'adult', 'firm'),
  v('Callirrhoe', 'female', 'adult', 'easy-going'),
  v('Despina', 'female', 'adult', 'smooth'),
  v('Erinome', 'female', 'adult', 'clear'),
  v('Achernar', 'female', 'adult', 'soft'),
  v('Pulcherrima', 'female', 'adult', 'forward'),
  v('Vindemiatrix', 'female', 'adult', 'gentle'),
  v('Sulafat', 'female', 'adult', 'warm'),
  v('Gacrux', 'female', 'elder', 'mature'),
  v('Puck', 'male', 'young', 'upbeat'),
  v('Fenrir', 'male', 'young', 'excitable'),
  v('Sadachbia', 'male', 'young', 'lively'),
  v('Zubenelgenubi', 'male', 'young', 'casual'),
  v('Achird', 'male', 'young', 'friendly'),
  v('Charon', 'male', 'adult', 'informative, steady'),
  v('Orus', 'male', 'adult', 'firm'),
  v('Enceladus', 'male', 'adult', 'breathy'),
  v('Iapetus', 'male', 'adult', 'clear'),
  v('Umbriel', 'male', 'adult', 'easy-going'),
  v('Algieba', 'male', 'adult', 'smooth'),
  v('Rasalgethi', 'male', 'adult', 'informative'),
  v('Alnilam', 'male', 'adult', 'firm'),
  v('Schedar', 'male', 'adult', 'even'),
  v('Sadaltager', 'male', 'adult', 'knowledgeable'),
  v('Algenib', 'male', 'elder', 'gravelly'),
]

/**
 * Voices of the Bailian audio generation model are descriptions in words: the
 * id is what the model is told. A clip made once from the description (the
 * "anchor") is what keeps a character sounding the same from line to line.
 */
const QWEN_AUDIOGEN: VoiceInfo[] = [
  v('清亮自然的年轻女声，语速适中', 'female', 'young', '清亮自然'),
  v('俏皮活泼、带一点笑意的少女音', 'female', 'young', '俏皮活泼'),
  v('温软安静、吐字轻柔的年轻女声', 'female', 'young', '温软安静'),
  v('清冷克制、语气平直的年轻女声', 'female', 'young', '清冷克制'),
  v('温柔沉静的成熟女声', 'female', 'adult', '温柔沉静'),
  v('知性干练、吐字清晰的女声', 'female', 'adult', '知性干练'),
  v('成熟而有韵味、略低的御姐音', 'female', 'adult', '成熟有韵味'),
  v('爽利泼辣、中气很足的女声', 'female', 'adult', '爽利泼辣'),
  v('慈祥而略带沙哑的老年女声', 'female', 'elder', '慈祥沙哑'),
  v('稚气清脆的小女孩声音', 'female', 'child', '小女孩'),
  v('阳光爽朗的青年男声', 'male', 'young', '阳光爽朗'),
  v('清冷克制、声线偏薄的青年男声', 'male', 'young', '清冷克制'),
  v('带点痞气、懒洋洋的年轻男声', 'male', 'young', '痞气慵懒'),
  v('温和斯文、不紧不慢的青年男声', 'male', 'young', '温和斯文'),
  v('磁性沉稳的中年男声', 'male', 'adult', '磁性沉稳'),
  v('浑厚有力、字正腔圆的男声', 'male', 'adult', '浑厚有力'),
  v('低沉沙哑的烟嗓男声', 'male', 'adult', '低沉烟嗓'),
  v('精明世故、语速偏快的中年男声', 'male', 'adult', '精明世故'),
  v('苍劲睿智、语速缓慢的老年男声', 'male', 'elder', '苍劲睿智'),
  v('机灵好动的小男孩声音', 'male', 'child', '小男孩'),
  v('平和中性、不带情绪起伏的讲述声音', 'neutral', 'adult', '平和中性'),
]

/** The narrator of an audio-generation provider when the settings name none. */
export const AUDIOGEN_NARRATOR = '沉稳、有故事感的中年男声，像深夜电台的讲述者'

/** The catalog that seeds casting and pickers for a provider (and, where it matters, a model). */
export function stockVoices(provider: TtsProviderKind, model?: string): VoiceInfo[] {
  if (provider === 'qwen-audiogen') return QWEN_AUDIOGEN
  if (provider === 'qwen-realtime') return QWEN_REALTIME
  if (provider === 'dashscope') return QWEN_TTS
  if (provider === 'openai') return OPENAI
  if (provider === 'openrouter') {
    if (model === undefined || /gemini/i.test(model)) return GEMINI
    if (/(^|\/)gpt-|(^|\/)tts-1/i.test(model)) return OPENAI
  }
  return []
}

/**
 * The voice a provider reads with when a request names none — which is how the
 * narrator speaks until the settings give them a voice. Casting keeps
 * characters off it, so nobody in the story sounds like the one telling it.
 */
const PROVIDER_DEFAULT: Partial<Record<TtsProviderKind, string>> = { dashscope: 'Cherry', openai: 'alloy' }

export function providerDefaultVoice(provider: TtsProviderKind): string | undefined {
  return PROVIDER_DEFAULT[provider]
}

/** Whether a provider takes voices as descriptions in words rather than ids. */
export function describesVoices(provider: TtsProviderKind): boolean {
  return provider === 'qwen-audiogen'
}

/** A description of a character's voice in words, from what their card says. */
export function describeVoice(card: Pick<CharacterCard, 'gender' | 'age' | 'voice' | 'personality' | 'appearance' | 'tagline'>): string | undefined {
  const spoken = card.voice?.trim()
  if (spoken === undefined || spoken.length === 0) return undefined
  const gender = guessGender(card)
  const age = guessAge(card)
  const who = `${age === 'child' ? '年幼的' : age === 'young' ? '年轻' : age === 'elder' ? '年老的' : '成年'}${gender === 'female' ? '女性' : gender === 'male' ? '男性' : '讲述者'}`
  return `${who}，${spoken}`.slice(0, 160)
}

/** Read a rough gender out of a free-text field. */
export function guessGender(card: Pick<CharacterCard, 'gender' | 'appearance' | 'tagline'>): VoiceGender {
  const text = `${card.gender ?? ''}`.toLowerCase()
  if (/女|female|woman|girl|\bf\b|她/.test(text)) return 'female'
  if (/男|male|man|boy|\bm\b|他/.test(text)) return 'male'
  const hint = `${card.tagline ?? ''} ${card.appearance ?? ''}`
  if (/她|女孩|少女|姑娘|女子|妇人|公主|女王|母亲/.test(hint)) return 'female'
  if (/他(?!们)|少年|男孩|男子|汉子|王子|父亲|老翁/.test(hint)) return 'male'
  return 'neutral'
}

export function guessAge(card: Pick<CharacterCard, 'age' | 'tagline'>): VoiceAge {
  const text = `${card.age ?? ''} ${card.tagline ?? ''}`
  const years = /(\d{1,3})\s*(?:岁|years?|yo)?/.exec(card.age ?? '')
  if (years !== null) {
    const age = Number(years[1])
    if (age <= 12) return 'child'
    if (age <= 28) return 'young'
    if (age >= 58) return 'elder'
    return 'adult'
  }
  if (/孩童|幼|小孩|儿童|child|kid/i.test(text)) return 'child'
  if (/老|暮年|elder|old/i.test(text)) return 'elder'
  if (/少年|少女|青年|年轻|young|teen/i.test(text)) return 'young'
  return 'adult'
}

/**
 * Pick a stock voice for a character that has none: match gender and age,
 * avoid accents unless asked, avoid voices already taken, and stay stable
 * for the same character.
 */
export function castVoice(card: CharacterCard, provider: TtsProviderKind, taken: ReadonlySet<string>, model?: string): string | undefined {
  // Where voices are words, the card's own description of the voice is the best casting there is.
  if (describesVoices(provider)) {
    const own = describeVoice(card)
    if (own !== undefined) return own
  }
  const voices = stockVoices(provider, model)
  if (voices.length === 0) return undefined
  const gender = guessGender(card)
  const age = guessAge(card)
  const plain = voices.filter(voice => voice.accent === undefined)
  const tiers = [
    plain.filter(voice => voice.gender === gender && voice.age === age),
    plain.filter(voice => voice.gender === gender && voice.age !== 'child'),
    plain.filter(voice => voice.gender === gender),
    plain,
    voices,
  ]
  const seed = parseInt(hashText(card.id).slice(0, 6), 16)
  for (const tier of tiers) {
    const free = tier.filter(voice => !taken.has(voice.id))
    if (free.length > 0) return free[seed % free.length]!.id
  }
  const pool = tiers.find(tier => tier.length > 0)!
  return pool[seed % pool.length]!.id
}

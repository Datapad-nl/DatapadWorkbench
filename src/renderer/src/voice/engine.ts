import type { VoiceLanguage, VoiceSettings } from '../../../shared/types'
import { plainReply } from '../../../shared/steps'
import { loadSupertonic, synthesize } from './supertonic'
import { getAsr } from './whisper'

const SAMPLE_RATE = 16000
const SILENCE_MS = 1400
const SPEECH_RMS = 0.0008
const MAX_MS = 60_000
const ASR_MAX_SEC = 8

export type TtsVoice = { voiceURI: string; name: string }

export const TTS_VOICES: TtsVoice[] = [
  { voiceURI: 'M1', name: 'Male 1' },
  { voiceURI: 'F1', name: 'Female 1' },
  { voiceURI: 'M2', name: 'Male 2' },
  { voiceURI: 'F2', name: 'Female 2' },
  { voiceURI: 'M3', name: 'Male 3' },
  { voiceURI: 'F3', name: 'Female 3' },
  { voiceURI: 'M4', name: 'Male 4' },
  { voiceURI: 'F4', name: 'Female 4' },
  { voiceURI: 'M5', name: 'Male 5' },
  { voiceURI: 'F5', name: 'Female 5' }
]

let speakGen = 0
let ttsContext: AudioContext | null = null
let ttsGain: GainNode | null = null
const liveSources = new Set<AudioBufferSourceNode>()

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = x - i0
    output[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return output
}

let onnxChain: Promise<unknown> = Promise.resolve()

function withOnnx<T>(fn: () => Promise<T>): Promise<T> {
  const run = onnxChain.then(fn, fn)
  onnxChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

let ttsTail: Promise<unknown> = Promise.resolve()

/** One local TTS session. The status worker has its own; this lane stays serial. */
function withTts<T>(fn: () => Promise<T>): Promise<T> {
  const run = ttsTail.then(fn, fn)
  ttsTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function getTts(): Promise<void> {
  const ready = await window.workbench.ensureVoiceModel()
  if (ready.state !== 'ready') throw new Error(ready.error || 'Speech model is not ready')
  await loadSupertonic()
}

type Pcm = { samples: Float32Array; sampleRate: number }

function speechSpeed(settings: VoiceSettings): number {
  return Math.min(2, Math.max(0.7, settings.rate))
}

/** One chunk through the local model, on the shared ONNX lane. */
function synthHere(text: string, lang: VoiceLanguage, settings: VoiceSettings): Promise<Pcm> {
  return withTts(() =>
    withOnnx(async () => {
      await getTts()
      return synthesize(text, lang, voiceId(settings), speechSpeed(settings))
    })
  )
}

function expandSpokenContractions(text: string): string {
  return text
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/\b(I|you|we|they|he|she|who)'ll\b/gi, (_full, pronoun: string) => {
      const spoken = pronoun.toLowerCase() === 'i' ? 'I' : pronoun
      return `${spoken} will`
    })
}

export function speakableText(markdown: string): string {
  let text = plainReply(markdown).replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`[^`]+`/g, ' ')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  text = text.replace(/[*_~>]+/g, '')
  text = text.replace(/\n{2,}/g, '. ')
  text = text.replace(/\s+/g, ' ').trim()
  text = expandSpokenContractions(text)
  if (text.length > 2500) text = `${text.slice(0, 2500).trim()}…`
  return text
}

const EN_WORDS = new Set(
  `the and to of that you with this for are have not but they from your can will what when how about there would could should just here also because which their been were into than then them our don't it's i'm you're that's isn't doesn't didn't i've we've can't won't please thanks thank`.split(
    /\s+/
  )
)

/** Common words per language Supertonic speaks, for picking the language tag. */
const LANG_WORDS: Array<[VoiceLanguage, Set<string>]> = [
  ['nl', new Set(`het een van niet zijn voor met ook maar naar wordt deze geen nog wel omdat door bij als wat dit dat uit over hebben heeft werd worden ik je jij wij zij hun onze jouw mijn moet graag alstublieft bedankt hoe waar waarom wanneer wie welk welke natuurlijk de en`.split(' '))],
  ['fr', new Set(`le la les une un que pour dans pas des avec vous nous cette sont qui sur par elle aux du au cela aussi mais donc très être avoir pourquoi quand parce quelle quel bonjour merci est`.split(' '))],
  ['de', new Set(`und nicht ich sie den von auf für dem sich auch nach wie aber eine ist der die das ein im zu zum zur mit dass schon wenn oder wir ihr uns euch mein keine muss haben hat wird werden wurde über weil bitte danke gerne`.split(' '))],
  ['es', new Set(`el los las del una para por con como esta esto pero más muy porque cuando también está son hay sus ese esa eso nos les ya sí gracias hola dónde cómo tiene puedes puede hacer sobre entre desde hasta todos todas este estos`.split(' '))],
  ['it', new Set(`che per sono come questa questo anche della degli delle nel nella gli lei noi voi loro perché quando dove cosa tutto tutti molto bene grazie ciao`.split(' '))],
  ['pt', new Set(`não com mais você isso pelo pela dos das num numa ele ela nós vocês muito obrigado obrigada`.split(' '))],
]

const OTHER_WORDS = new Set(LANG_WORDS.flatMap(([, words]) => [...words]))

const OTHER_GREETINGS = new Set(
  'bonjour merci gracias hola ciao obrigado obrigada danke bitte hallo hoi doei goedemorgen alstublieft dankjewel bedankt'.split(
    /\s+/
  )
)

function speechWords(text: string): string[] {
  return text.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? []
}

function countWords(words: string[], dict: Set<string>): number {
  let n = 0
  for (const word of words) if (dict.has(word)) n++
  return n
}

/** English or not. `unknown` means there is not enough text to decide yet. */
export function textLanguage(text: string): 'en' | 'other' | 'unknown' {
  const trimmed = text.trim()
  if (!trimmed) return 'unknown'
  const letters = trimmed.match(/\p{L}/gu) ?? []
  const nonLatin = trimmed.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Cyrillic}|\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Devanagari}|\p{Script=Thai}|\p{Script=Greek}/gu) ?? []
  if (nonLatin.length >= 4 && nonLatin.length >= letters.length * 0.25) return 'other'
  const words = speechWords(trimmed)
  if (words.length === 0) return 'unknown'
  const en = countWords(words, EN_WORDS)
  const other = countWords(words, OTHER_WORDS)
  const greeting = words.some((word) => OTHER_GREETINGS.has(word))
  if (greeting && en === 0) return 'other'
  if (words.length === 1 && other === 1 && en === 0) return 'other'
  if (other >= 2 && other > en) return 'other'
  const diacritics = trimmed.match(/[àáâäãåæçèéêëìíîïñòóôöõùúûüýÿœ]/gi) ?? []
  if (diacritics.length >= 3 && en === 0 && words.length >= 3) return 'other'
  if (en >= 2 && en >= other) return 'en'
  if (en >= 1 && other === 0 && words.length >= 4) return 'en'
  if (words.length >= 8 && other === 0) return 'en'
  if (words.length >= 8 && other > en) return 'other'
  return 'unknown'
}

const SCRIPT_LANGS: Array<[RegExp, VoiceLanguage]> = [
  [/\p{Script=Hangul}/gu, 'ko'],
  [/\p{Script=Hiragana}|\p{Script=Katakana}/gu, 'ja'],
  [/\p{Script=Arabic}/gu, 'ar'],
  [/\p{Script=Greek}/gu, 'el'],
  [/\p{Script=Devanagari}/gu, 'hi'],
  [/[іїєґІЇЄҐ]/gu, 'uk'],
  [/\p{Script=Cyrillic}/gu, 'ru']
]

/** The language tag to read `text` with. `na` when it is not one Supertonic knows by sight. */
export function speechLanguage(text: string, settings: VoiceSettings): VoiceLanguage {
  if (settings.language !== 'auto') return settings.language as VoiceLanguage
  const letters = (text.match(/\p{L}/gu) ?? []).length
  for (const [script, lang] of SCRIPT_LANGS) {
    const hits = (text.match(script) ?? []).length
    if (hits >= 2 && hits >= letters * 0.25) return lang
  }
  if (textLanguage(text) !== 'other') return 'en'
  const words = speechWords(text)
  let best: [VoiceLanguage, number] = ['na', 0]
  for (const [lang, dict] of LANG_WORDS) {
    const hits = countWords(words, dict)
    if (hits > best[1]) best = [lang, hits]
  }
  return best[0]
}

function containsWordSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  const limit = haystack.length - needle.length
  for (let i = 0; i <= limit; i++) {
    let same = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        same = false
        break
      }
    }
    if (same) return true
  }
  return false
}

function stripLeadingWords(text: string, count: number): string {
  const re = /\p{L}+(?:['’]\p{L}+)?/gu
  let skipped = 0
  let end = 0
  for (const match of text.matchAll(re)) {
    skipped += 1
    end = (match.index ?? 0) + match[0].length
    if (skipped >= count) break
  }
  return text.slice(end).replace(/^[\s,.;:!?…—-]+/u, '').trim()
}

/**
 * Skip speech that is only the user's request read back.
 * A shorter answer is kept. While streaming, a still-growing copy of the request is held
 * until the reply continues or the turn finishes.
 */
export function dropSpokenUserEcho(assistant: string, user: string, flush = false): string {
  const reply = assistant.trim()
  if (!reply) return ''
  const ask = speechWords(user)
  if (ask.length < 6) return reply
  const said = speechWords(reply)
  if (said.length === 0) return reply
  const askJoined = ask.join(' ')
  const saidJoined = said.join(' ')
  if (saidJoined === askJoined) return ''
  if (!flush && askJoined.startsWith(saidJoined)) return ''
  if (!saidJoined.startsWith(askJoined)) return reply
  const rest = stripLeadingWords(reply, ask.length)
  if (speechWords(rest).length < 4) return ''
  return rest
}

/** True when a progress line is quoting the user's request. */
export function echoesUserRequest(spoken: string, user: string): boolean {
  const ask = speechWords(user)
  if (ask.length < 6) return false
  const said = speechWords(spoken)
  if (containsWordSequence(said, ask)) return true
  const head = ask.slice(0, 12)
  return head.length >= 6 && head.length < ask.length && containsWordSequence(said, head)
}

function voiceId(settings: VoiceSettings): string {
  return TTS_VOICES.some((item) => item.voiceURI === settings.voiceURI) ? settings.voiceURI : 'M1'
}

const STREAM_CLAUSE = 220
const SPEAK_CHUNK = 280

/** A sentence longer than one chunk, cut between words. A single longer word stays whole. */
function splitLongSentence(part: string): string[] {
  if (part.length <= SPEAK_CHUNK) return [part]
  const pieces: string[] = []
  let piece = ''
  for (const word of part.split(/(?<=\s)/)) {
    if (piece.length + word.length > SPEAK_CHUNK && piece.trim()) {
      pieces.push(piece)
      piece = word
    } else {
      piece += word
    }
  }
  if (piece) pieces.push(piece)
  return pieces
}

function splitSpeakChunks(text: string): string[] {
  const parts = (text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [text]).flatMap(splitLongSentence)
  const chunks: string[] = []
  let buf = ''
  for (const part of parts) {
    const next = `${buf}${part}`
    if (next.length > SPEAK_CHUNK && buf.trim()) {
      chunks.push(buf.trim())
      buf = part
    } else {
      buf = next
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks
}

export function takeSpeakableDelta(
  full: string,
  consumed: string,
  flush: boolean
): { speak: string; consumed: string } {
  if (!full) return { speak: '', consumed: flush ? full : consumed }
  let prefix = consumed
  if (!full.startsWith(consumed)) {
    if (!flush) return { speak: '', consumed }
    let i = 0
    const n = Math.min(consumed.length, full.length)
    while (i < n && consumed[i] === full[i]) i++
    prefix = full.slice(0, i)
  }
  const rest = full.slice(prefix.length)
  if (!rest) return { speak: '', consumed: prefix }
  if (flush) return { speak: rest.trim(), consumed: full }
  const complete = rest.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g)
  let used = complete ? complete.join('') : ''
  const leftover = rest.slice(used.length)
  if (leftover.trim().length >= STREAM_CLAUSE) used += leftover
  return { speak: used.trim(), consumed: prefix + used }
}

function stopPlayback(): void {
  if (ttsGain) ttsGain.gain.value = 0
  for (const source of liveSources) {
    try {
      source.stop()
    } catch {
      // already stopped
    }
    try {
      source.disconnect()
    } catch {
      // already disconnected
    }
  }
  liveSources.clear()
}

function ensureTtsOutput(sampleRate: number): { context: AudioContext; gain: GainNode } {
  if (!ttsContext) {
    ttsContext = new AudioContext({ sampleRate })
    ttsGain = ttsContext.createGain()
    ttsGain.connect(ttsContext.destination)
  }
  ttsGain ??= ttsContext.createGain()
  return { context: ttsContext, gain: ttsGain }
}

let audioWarmed = false

/** The window's first AudioContext blocks it for a few hundred ms while audio starts up. Later ones open at once. */
export function warmAudioOutput(): void {
  if (audioWarmed) return
  audioWarmed = true
  void new AudioContext().close().catch(() => undefined)
}

export function primeTtsOutput(): void {
  const { context, gain } = ensureTtsOutput(22050)
  gain.gain.value = 1
  if (context.state === 'suspended' && !replyHeld) void context.resume()
}

function dropSource(source: AudioBufferSourceNode): void {
  liveSources.delete(source)
  try {
    source.stop()
  } catch {
    // already stopped
  }
  try {
    source.disconnect()
  } catch {
    // already disconnected
  }
}

async function playPcm(samples: Float32Array, sampleRate: number, gen: number): Promise<void> {
  if (gen !== speakGen) return
  const { context, gain } = ensureTtsOutput(sampleRate)
  while (replyHeld && gen === speakGen) await waitReplyFree()
  if (gen !== speakGen) return
  if (context.state === 'suspended') await context.resume()
  if (gen !== speakGen) return
  const buffer = context.createBuffer(1, samples.length, sampleRate)
  buffer.getChannelData(0).set(samples)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(gain)
  liveSources.add(source)
  if (gen !== speakGen) {
    dropSource(source)
    return
  }
  gain.gain.value = 1
  await new Promise<void>((resolve) => {
    source.onended = () => {
      liveSources.delete(source)
      resolve()
    }
    if (gen !== speakGen) {
      dropSource(source)
      resolve()
      return
    }
    source.start()
  })
}

type SpeakJob = { text: string; lang: VoiceLanguage; settings: VoiceSettings }

let speakQueue: SpeakJob[] = []
let drainPromise: Promise<void> | null = null

export function stopSpeaking(): void {
  speakGen += 1
  speakQueue = []
  drainPromise = null
  wakeReplyWaiters()
  cancelTtsJobs(false)
  stopPlayback()
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

export function isSpeaking(): boolean {
  // The system voice reads replies when the local model fails.
  const system = typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending)
  return liveSources.size > 0 || speakQueue.length > 0 || drainPromise !== null || system
}

/**
 * Status lines ("still working") synthesize on a worker and play on their own
 * audio context. Pausing the reply context keeps the reply sentence intact,
 * and reply cancellation does not stop the status line.
 */
let asideContext: AudioContext | null = null
let asideGain: GainNode | null = null
let asideGen = 0
let asideJob: Promise<void> | null = null
/** The line playing, and the newest line waiting behind it. */
let asideSpoken = ''
let asideQueued = ''
let asideTicket = 0
let replyHeld = false
let replyHoldWait: Array<() => void> = []
const asideSources = new Set<AudioBufferSourceNode>()

type TtsOut =
  | { type: 'ready' }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id?: number; message: string }

/**
 * One worker holds the speech model for replies and status lines, so the model is in memory
 * once and synthesis stays off the UI thread. The UI thread loads its own copy only when the
 * worker cannot run.
 */
let ttsWorker: Worker | null = null
let ttsWorkerBrokenUntil = 0
let ttsWorkerReady: Promise<void> | null = null
let ttsReadyWait: { resolve: () => void; reject: (error: Error) => void } | null = null
let ttsSeq = 0
type TtsJob = {
  message: { type: 'synth'; id: number; text: string; lang: VoiceLanguage; voice: string; speed: number; urgent: boolean }
  resolve: (audio: Pcm) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}
const ttsPending = new Map<number, TtsJob>()
/** A job the worker has not answered in this long is stuck. */
const TTS_JOB_MS = 30_000
/** The model takes several hundred MB. After this long without speech the worker goes; loading again takes under a second. */
const TTS_IDLE_MS = 3 * 60_000
let ttsIdleTimer: ReturnType<typeof setTimeout> | null = null
/** A worker that failed sits out this long. The next request after that tries a fresh one. */
const WORKER_RETRY_MS = 60_000

function ttsWorkerBroken(): boolean {
  return Date.now() < ttsWorkerBrokenUntil
}

function scheduleTtsRelease(): void {
  if (ttsIdleTimer) clearTimeout(ttsIdleTimer)
  ttsIdleTimer = setTimeout(() => {
    ttsIdleTimer = null
    if (ttsPending.size > 0 || ttsReadyWait) {
      scheduleTtsRelease()
      return
    }
    ttsWorker?.terminate()
    ttsWorker = null
    ttsWorkerReady = null
  }, TTS_IDLE_MS)
}

function waitReplyFree(): Promise<void> {
  return new Promise((resolve) => {
    replyHoldWait.push(resolve)
  })
}

function wakeReplyWaiters(): void {
  const waiters = replyHoldWait
  replyHoldWait = []
  for (const wake of waiters) wake()
}

async function holdReply(): Promise<void> {
  replyHeld = true
  const context = ttsContext
  if (context?.state === 'running') await context.suspend()
  if (!replyHeld) {
    wakeReplyWaiters()
    if (context?.state === 'suspended') await context.resume()
    return
  }
  if (typeof speechSynthesis !== 'undefined') {
    try {
      if (speechSynthesis.speaking && !speechSynthesis.paused) speechSynthesis.pause()
    } catch {
      // pause is unavailable
    }
  }
}

async function releaseReply(): Promise<void> {
  if (!replyHeld) return
  replyHeld = false
  wakeReplyWaiters()
  if (ttsContext?.state === 'suspended') await ttsContext.resume()
  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.paused) {
    try {
      speechSynthesis.resume()
    } catch {
      // resume is unavailable
    }
  }
}

function ensureAsideOutput(sampleRate: number): { context: AudioContext; gain: GainNode } {
  if (!asideContext) {
    asideContext = new AudioContext({ sampleRate })
    asideGain = asideContext.createGain()
    asideGain.connect(asideContext.destination)
  }
  asideGain ??= asideContext.createGain()
  return { context: asideContext, gain: asideGain }
}

function stopAsideSources(): void {
  for (const source of asideSources) {
    try {
      source.stop()
    } catch {
      // already stopped
    }
    try {
      source.disconnect()
    } catch {
      // already disconnected
    }
  }
  asideSources.clear()
}

export function isAsideSpeaking(): boolean {
  return asideJob !== null || asideQueued !== ''
}

export function stopAside(): void {
  asideGen += 1
  asideQueued = ''
  cancelTtsJobs(true)
  stopAsideSources()
  void releaseReply()
}

/** Closes both audio contexts once voice is off. The next speech opens new ones. */
export function releaseAudio(): void {
  stopPlayback()
  stopAsideSources()
  void ttsContext?.close().catch(() => undefined)
  void asideContext?.close().catch(() => undefined)
  ttsContext = null
  ttsGain = null
  asideContext = null
  asideGain = null
}

function asideError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Status voice failed')
}

function rejectTtsJobs(error: Error): void {
  ttsReadyWait?.reject(error)
  ttsReadyWait = null
  for (const id of [...ttsPending.keys()]) takeTtsJob(id)?.reject(error)
}

/** Removes a job so it settles once. */
function takeTtsJob(id: number): TtsJob | undefined {
  const job = ttsPending.get(id)
  if (!job) return undefined
  ttsPending.delete(id)
  if (job.timer) clearTimeout(job.timer)
  return job
}

function postTtsJob(worker: Worker, job: TtsJob): void {
  if (job.timer) clearTimeout(job.timer)
  job.timer = setTimeout(() => timeOutTtsJob(job.message.id), TTS_JOB_MS)
  worker.postMessage(job.message)
}

/** Only the stuck job fails. The worker is replaced and the jobs behind it go to the new one. */
function timeOutTtsJob(id: number): void {
  takeTtsJob(id)?.reject(new Error('Speech timed out'))
  ttsWorker?.terminate()
  ttsWorker = null
  ttsWorkerReady = null
  // The others wait for the new worker. Their clocks start again when they are sent to it.
  for (const job of ttsPending.values()) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
  }
  if (ttsPending.size === 0) return
  loadTtsWorker().then(
    () => {
      const worker = ttsWorkerHandle()
      for (const job of ttsPending.values()) postTtsJob(worker, job)
    },
    (error: unknown) => rejectTtsJobs(error instanceof Error ? error : new Error('Speech worker failed'))
  )
}

/** Ends one lane's jobs with no audio, and tells the worker to skip the ones it has not started. */
function cancelTtsJobs(urgent: boolean): void {
  const ids = [...ttsPending.values()].filter((job) => job.message.urgent === urgent).map((job) => job.message.id)
  if (ids.length === 0) return
  for (const id of ids) takeTtsJob(id)?.resolve({ samples: new Float32Array(0), sampleRate: SAMPLE_RATE })
  ttsWorker?.postMessage({ type: 'cancel', ids })
}

/** Until then the model files failed to load on the worker. They would fail on the UI thread too. */
let ttsModelBrokenUntil = 0

function failTtsWorker(error: Error, modelFailed = false): void {
  ttsWorkerBrokenUntil = Date.now() + WORKER_RETRY_MS
  if (modelFailed) ttsModelBrokenUntil = ttsWorkerBrokenUntil
  resetTtsWorker(error)
}

/** Drop a stuck worker. The next request starts a fresh one. */
function resetTtsWorker(error: Error): void {
  ttsWorker?.terminate()
  ttsWorker = null
  ttsWorkerReady = null
  rejectTtsJobs(error)
}

function ttsWorkerHandle(): Worker {
  if (ttsWorker) return ttsWorker
  const worker = new Worker(new URL('./asideTts.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<TtsOut>) => {
    const message = event.data
    scheduleTtsRelease()
    if (message.type === 'ready') {
      ttsReadyWait?.resolve()
      ttsReadyWait = null
      return
    }
    if (message.type === 'error') {
      const id = message.id
      if (id === undefined) {
        // Only loading the model reports an error without a job.
        failTtsWorker(new Error(message.message), true)
        return
      }
      takeTtsJob(id)?.reject(new Error(message.message))
      return
    }
    takeTtsJob(message.id)?.resolve({ samples: message.samples, sampleRate: message.sampleRate })
  }
  worker.onerror = (event) => failTtsWorker(new Error(event.message || 'Speech worker failed'))
  ttsWorker = worker
  return worker
}

/** Load the model on the worker once. Resolves when it can synthesize. */
function loadTtsWorker(): Promise<void> {
  if (ttsWorkerReady) return ttsWorkerReady
  const ready = (async () => {
    const model = await window.workbench.ensureVoiceModel()
    if (model.state !== 'ready') throw new Error(model.error || 'Speech model is not ready')
    let worker: Worker
    try {
      worker = ttsWorkerHandle()
    } catch (error) {
      failTtsWorker(error instanceof Error ? error : new Error('Speech worker failed'))
      throw error
    }
    await new Promise<void>((resolve, reject) => {
      ttsReadyWait = { resolve, reject }
      worker.postMessage({ type: 'load' })
    })
  })()
  ttsWorkerReady = ready
  ready.catch(() => {
    if (ttsWorkerReady === ready) ttsWorkerReady = null
  })
  return ready
}

export function warmAsideVoice(): void {
  if (ttsWorkerBroken()) return
  loadTtsWorker().catch((error: unknown) => console.error('voice worker', error))
}

async function synthOnWorker(text: string, lang: VoiceLanguage, settings: VoiceSettings, urgent: boolean): Promise<Pcm> {
  const gen = urgent ? asideGen : speakGen
  await loadTtsWorker()
  // Speech that stopped while the model loaded is not sent; callers drop empty audio.
  if (gen !== (urgent ? asideGen : speakGen)) return { samples: new Float32Array(0), sampleRate: SAMPLE_RATE }
  const worker = ttsWorkerHandle()
  const id = ++ttsSeq
  return new Promise((resolve, reject) => {
    const job: TtsJob = {
      message: { type: 'synth', id, text, lang, voice: voiceId(settings), speed: speechSpeed(settings), urgent },
      resolve,
      reject,
      timer: null
    }
    ttsPending.set(id, job)
    postTtsJob(worker, job)
  })
}

/** Synthesize on the shared worker. Falls back to the UI thread only when the worker cannot run. */
async function synth(text: string, lang: VoiceLanguage, settings: VoiceSettings, urgent: boolean): Promise<Pcm> {
  if (!ttsWorkerBroken()) {
    try {
      return await synthOnWorker(text, lang, settings, urgent)
    } catch (error) {
      if (!ttsWorkerBroken()) throw error
      console.error('voice worker', error)
    }
  }
  // Loading model files that just failed on the worker would block the window, then fail the same way.
  if (Date.now() < ttsModelBrokenUntil) throw new Error('Speech model failed to load')
  return synthHere(text, lang, settings)
}

async function playAside(samples: Float32Array, sampleRate: number, gen: number): Promise<void> {
  if (gen !== asideGen) return
  const { context, gain } = ensureAsideOutput(sampleRate)
  if (context.state === 'suspended') await context.resume()
  if (gen !== asideGen) return
  if (context.state !== 'running') throw new Error('Status voice could not start')
  await holdReply()
  if (gen !== asideGen) {
    await releaseReply()
    return
  }
  const buffer = context.createBuffer(1, samples.length, sampleRate)
  buffer.getChannelData(0).set(samples)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(gain)
  asideSources.add(source)
  gain.gain.value = 1
  try {
    await new Promise<void>((resolve) => {
      source.onended = () => {
        asideSources.delete(source)
        resolve()
      }
      if (gen !== asideGen) {
        asideSources.delete(source)
        try {
          source.stop()
        } catch {
          // already stopped
        }
        resolve()
        return
      }
      source.start()
    })
  } finally {
    if (gen === asideGen) await releaseReply()
  }
}

export async function speakAside(text: string, settings: VoiceSettings): Promise<void> {
  const spoken = speakableText(text)
  if (!spoken) return
  if (asideJob) {
    // One line waits behind the one playing. A newer line takes its place, and a repeat is dropped.
    if (spoken === asideSpoken || spoken === asideQueued) return
    asideQueued = spoken
    const ticket = ++asideTicket
    const waitGen = asideGen
    while (asideJob) await asideJob.catch(() => undefined)
    if (ticket !== asideTicket || waitGen !== asideGen) return
    asideQueued = ''
  }
  const gen = asideGen
  asideSpoken = spoken
  // The job clears itself before it settles, so a line waiting on it finds the slot free.
  let run: Promise<void> | null = null
  run = (async () => {
    try {
      const audio = await synth(spoken, speechLanguage(spoken, settings), settings, true)
      if (gen !== asideGen) return
      await playAside(audio.samples, audio.sampleRate, gen)
    } catch (error) {
      if (gen === asideGen) await releaseReply()
      throw asideError(error)
    } finally {
      if (asideJob === run) {
        asideJob = null
        asideSpoken = ''
      }
    }
  })()
  asideJob = run
  await run
}

export function listVoices(): TtsVoice[] {
  return TTS_VOICES
}

function drainQueue(): Promise<void> {
  if (drainPromise) return drainPromise
  if (speakQueue.length === 0) return Promise.resolve()
  const gen = speakGen
  let run: Promise<void> | null = null
  run = (async () => {
    try {
      while (speakQueue.length) {
        if (gen !== speakGen) return
        const job = speakQueue.shift()
        if (!job) break
        try {
          const { samples, sampleRate } = await synth(job.text, job.lang, job.settings, false)
          if (gen !== speakGen) return
          if (samples.length === 0) continue
          await playPcm(samples, sampleRate, gen)
          if (gen !== speakGen) return
          playedKeys.add(normKey(job.text))
        } catch (error) {
          if (gen === speakGen) speakQueue.unshift(job)
          throw error
        }
      }
    } finally {
      if (drainPromise === run) drainPromise = null
    }
  })()
  drainPromise = run
  return run
}

const playedKeys = new Set<string>()

function normKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function resetSpokenLog(): void {
  playedKeys.clear()
}

export async function speakText(
  text: string,
  settings: VoiceSettings,
  opts?: { append?: boolean; repeat?: boolean; lang?: VoiceLanguage }
): Promise<void> {
  const spoken = speakableText(text)
  // One language for the whole text, so a short sentence does not switch accents.
  const lang = opts?.lang ?? speechLanguage(spoken, settings)
  if (!opts?.append) stopSpeaking()
  if (spoken) {
    for (const chunk of splitSpeakChunks(spoken)) {
      const key = normKey(chunk)
      if (!key) continue
      if (!opts?.repeat && playedKeys.has(key)) continue
      if (speakQueue.some((job) => normKey(job.text) === key)) continue
      speakQueue.push({ text: chunk, lang, settings })
    }
  }
  if (speakQueue.length === 0 && !opts?.append) return
  const gen = speakGen
  try {
    await drainQueue()
  } catch {
    if (gen !== speakGen) return
    const rest = speakQueue.map((job) => job.text).join(' ')
    speakQueue = []
    if (!rest.trim()) return
    await speakBrowser(rest, settings, gen)
  }
}

async function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  const have = speechSynthesis.getVoices()
  if (have.length > 0) return have
  await new Promise<void>((resolve) => {
    const done = (): void => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      resolve()
    }
    speechSynthesis.addEventListener('voiceschanged', done)
    setTimeout(done, 400)
  })
  return speechSynthesis.getVoices()
}

async function speakBrowser(text: string, settings: VoiceSettings, gen: number): Promise<void> {
  if (typeof speechSynthesis === 'undefined') {
    throw new Error('No speech engine available')
  }
  const voices = await browserVoices()
  if (gen !== speakGen) return
  await new Promise<void>((resolve) => {
    const utter = new SpeechSynthesisUtterance(text)
    utter.rate = Math.min(2, Math.max(0.7, settings.rate))
    const female = settings.voiceURI.startsWith('F')
    const match = voices.find((voice) =>
      female
        ? /female|samantha|karen|moira|zira|fiona|siri/i.test(voice.name)
        : /male|daniel|alex|david|fred|tom/i.test(voice.name)
    )
    if (match) utter.voice = match
    utter.onend = () => resolve()
    utter.onerror = () => resolve()
    speechSynthesis.speak(utter)
  })
}

const JUNK_WORDS = new Set([
  'you',
  'uh',
  'um',
  'huh',
  'hmm',
  'ah',
  'oh',
  'yeah',
  'yes',
  'the',
  'a',
  'i',
  'and',
  'thank',
  'thanks'
])

export function isJunkTranscript(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return true
  if (words.length <= 2 && words.every((word) => JUNK_WORDS.has(word))) return true
  return false
}

function cleanTranscript(text: string, heardSpeech: boolean): string {
  const trimmed = text.trim()
  if (!trimmed || isJunkTranscript(trimmed)) return ''
  if (!heardSpeech && trimmed.split(/\s+/).length < 3) return ''
  return trimmed
}

type AsrOut = { id: number; text: string } | { id: number; error: string }

/** Recognition runs on its own worker so the UI keeps moving. The UI thread runs it only when the worker cannot. */
let asrWorker: Worker | null = null
let asrWorkerBrokenUntil = 0
let asrSeq = 0
const asrPending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
const ASR_TIMEOUT_MS = 60_000

function asrWorkerBroken(): boolean {
  return Date.now() < asrWorkerBrokenUntil
}

/** Drop the worker and fail its jobs. The next clip starts a fresh one. */
function resetAsrWorker(error: Error): void {
  asrWorker?.terminate()
  asrWorker = null
  for (const pending of asrPending.values()) pending.reject(error)
  asrPending.clear()
}

function asrWorkerHandle(): Worker {
  if (asrWorker) return asrWorker
  let worker: Worker
  try {
    worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    asrWorkerBrokenUntil = Date.now() + WORKER_RETRY_MS
    throw error
  }
  worker.onmessage = (event: MessageEvent<AsrOut>) => {
    const message = event.data
    const pending = asrPending.get(message.id)
    if (!pending) return
    asrPending.delete(message.id)
    if ('error' in message) pending.reject(new Error(message.error))
    else pending.resolve(message.text)
  }
  worker.onerror = (event) => {
    asrWorkerBrokenUntil = Date.now() + WORKER_RETRY_MS
    resetAsrWorker(new Error(event.message || 'Speech recognition worker failed'))
  }
  asrWorker = worker
  return worker
}

function transcribeOnWorker(audio: Float32Array): Promise<string> {
  const worker = asrWorkerHandle()
  const id = ++asrSeq
  // A copy, so transferring it never detaches the caller's samples.
  const copy = audio.slice()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resetAsrWorker(new Error('Speech recognition timed out')), ASR_TIMEOUT_MS)
    asrPending.set(id, {
      resolve: (text) => {
        clearTimeout(timer)
        resolve(text)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
    worker.postMessage({ id, audio: copy }, [copy.buffer])
  })
}

export async function transcribePcm(
  samples: Float32Array,
  sampleRate: number,
  heardSpeech = true
): Promise<string> {
  const audio = resample(samples, sampleRate, SAMPLE_RATE)
  const max = SAMPLE_RATE * ASR_MAX_SEC
  const clipped = audio.length > max ? audio.subarray(audio.length - max) : audio
  if (!asrWorkerBroken()) {
    try {
      return cleanTranscript(await transcribeOnWorker(clipped), heardSpeech)
    } catch (error) {
      if (!asrWorkerBroken()) throw error
      console.error('speech recognition worker', error)
    }
  }
  return withOnnx(async () => {
    const pipe = await getAsr()
    const result = await pipe(clipped)
    return cleanTranscript(result.text ?? '', heardSpeech)
  })
}

export type PcmClip = { samples: Float32Array; sampleRate: number; heardSpeech: boolean }

export type Recorder = {
  stop: () => Promise<PcmClip>
}

export const WAVE_BARS = 7

export type VoiceMotion = { bands: number[]; level: number }

const quietBands = (): number[] => Array.from({ length: WAVE_BARS }, () => 0)

let voiceMotion: VoiceMotion = { bands: quietBands(), level: 0 }

export function getVoiceMotion(): VoiceMotion {
  return voiceMotion
}

export function resetVoiceMotion(): void {
  voiceMotion = { bands: quietBands(), level: 0 }
}

export type MicInput = { deviceId: string; label: string }

export async function listMicInputs(): Promise<MicInput[]> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((track) => track.stop())
  } catch {
    // device labels stay hidden until permission is granted
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  const seen = new Set<string>()
  const mics: MicInput[] = []
  for (const item of devices) {
    if (item.kind !== 'audioinput' || !item.deviceId || seen.has(item.deviceId)) continue
    seen.add(item.deviceId)
    mics.push({
      deviceId: item.deviceId,
      label: item.label.trim() || `Microphone ${mics.length + 1}`
    })
  }
  return mics
}

function isUnusableMic(label: string, deviceId: string): boolean {
  const name = label.toLowerCase()
  if (deviceId === 'default' || deviceId === 'communications') return true
  if (name.startsWith('default -') || name.startsWith('communications -')) return true
  if (name.includes('virtual') || name.includes('teams audio')) return true
  if (name.includes('iphone') || name.includes('ipad')) return true
  return false
}

async function openMicStream(deviceId?: string): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio })
  } catch (error) {
    if (!deviceId) throw error
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }
}

type MicAudioData = {
  sampleRate: number
  allocationSize: (opts: { planeIndex: number; format: string }) => number
  copyTo: (dest: Float32Array, opts: { planeIndex: number; format: string }) => void
  close: () => void
}

type TrackProcessor = {
  readable: ReadableStream<MicAudioData>
}

function trackProcessor(track: MediaStreamTrack): TrackProcessor | null {
  const Ctor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessor
    }
  ).MediaStreamTrackProcessor
  if (!Ctor) return null
  return new Ctor({ track })
}

async function readPcmFrame(
  reader: ReadableStreamDefaultReader<MicAudioData>
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const { value, done } = await reader.read()
  if (done || !value) return null
  try {
    const bytes = value.allocationSize({ planeIndex: 0, format: 'f32-planar' })
    const samples = new Float32Array(bytes / 4)
    value.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
    return { samples, sampleRate: value.sampleRate }
  } finally {
    value.close()
  }
}

async function streamSignalScore(stream: MediaStream, ms: number): Promise<number> {
  const track = stream.getAudioTracks()[0]
  if (!track || track.readyState !== 'live') return 0
  const processor = trackProcessor(track)
  if (!processor) return 1
  const reader = processor.readable.getReader()
  const deadline = performance.now() + ms
  let nz = 0
  try {
    while (performance.now() < deadline) {
      const frame = await readPcmFrame(reader)
      if (!frame) break
      for (let i = 0; i < frame.samples.length; i++) {
        if (Math.abs(frame.samples[i] ?? 0) > 1e-5) nz++
      }
      if (nz > 80) return nz
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already cancelled */
    }
  }
  return nz
}

export async function openLiveMicStream(preferredId?: string): Promise<MediaStream> {
  const mics = await listMicInputs()
  const ordered: string[] = []
  if (preferredId) ordered.push(preferredId)
  for (const mic of mics) {
    if (!isUnusableMic(mic.label, mic.deviceId) && !ordered.includes(mic.deviceId)) {
      ordered.push(mic.deviceId)
    }
  }
  let fallback: MediaStream | null = null
  for (const id of ordered) {
    let stream: MediaStream
    try {
      stream = await openMicStream(id)
    } catch {
      continue
    }
    // A mic whose probe fails counts as silent, so it is closed or kept like any other.
    const score = await streamSignalScore(stream, 220).catch(() => 0)
    if (score > 80) {
      fallback?.getTracks().forEach((track) => track.stop())
      return stream
    }
    if (!fallback) fallback = stream
    else stream.getTracks().forEach((track) => track.stop())
  }
  if (fallback) return fallback
  return openMicStream()
}

export async function startRecorder(handlers: {
  context?: AudioContext
  deviceId?: string
  stream?: MediaStream
  idleStop?: boolean
  onLevel: (rms: number, silentFor: number, heardSpeech: boolean) => void
  onAutoStop: (clip: PcmClip) => void
}): Promise<Recorder> {
  const stream = handlers.stream ?? (await openLiveMicStream(handlers.deviceId))
  for (const track of stream.getAudioTracks()) track.enabled = true
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stream.getTracks().forEach((item) => item.stop())
    throw new Error('No microphone track')
  }
  const chunks: Float32Array[] = []
  let sampleRate = track.getSettings().sampleRate ?? SAMPLE_RATE
  let heard = false
  let silentMs = 0
  let last = performance.now()
  const started = last
  let stopping = false

  function onPcm(input: Float32Array, rate: number): void {
    if (stopping || input.length === 0) return
    sampleRate = rate
    chunks.push(new Float32Array(input))
    let sum = 0
    let peak = 0
    for (let i = 0; i < input.length; i++) {
      const sample = input[i] ?? 0
      sum += sample * sample
      const amp = Math.abs(sample)
      if (amp > peak) peak = amp
    }
    const rms = Math.sqrt(sum / input.length)
    const now = performance.now()
    const dt = now - last
    last = now
    if (rms >= SPEECH_RMS || peak >= SPEECH_RMS) {
      heard = true
      silentMs = 0
    } else if (heard) {
      silentMs += dt
    }
    handlers.onLevel(rms, silentMs, heard)
    const voice = Math.min(1, Math.max(peak * 80, rms * 120))
    const bands = new Array<number>(WAVE_BARS)
    const size = Math.max(1, Math.floor(input.length / WAVE_BARS))
    for (let i = 0; i < WAVE_BARS; i++) {
      let band = 0
      const start = i * size
      const end = i === WAVE_BARS - 1 ? input.length : start + size
      for (let j = start; j < end; j++) band += (input[j] ?? 0) * (input[j] ?? 0)
      bands[i] = Math.min(1, Math.sqrt(band / Math.max(1, end - start)) * 120 + voice * 0.35)
    }
    voiceMotion = { bands, level: voice }
    if (handlers.idleStop === false) return
    if (now - started > MAX_MS || (heard && silentMs >= SILENCE_MS)) {
      void stop().then(handlers.onAutoStop)
    }
  }

  const processor = trackProcessor(track)
  if (!processor) {
    stream.getTracks().forEach((item) => item.stop())
    throw new Error('This Chromium build cannot read microphone PCM')
  }
  const reader = processor.readable.getReader()
  const pump = (async () => {
    try {
      while (!stopping) {
        const frame = await readPcmFrame(reader)
        if (!frame) break
        onPcm(frame.samples, frame.sampleRate)
      }
    } catch {
      /* reader cancelled */
    }
  })()

  let finished: Promise<PcmClip> | null = null

  async function stop(): Promise<PcmClip> {
    if (finished) return finished
    stopping = true
    resetVoiceMotion()
    finished = (async () => {
      try {
        await reader.cancel()
      } catch {
        /* already cancelled */
      }
      await pump
      stream.getTracks().forEach((item) => item.stop())
      const length = chunks.reduce((n, chunk) => n + chunk.length, 0)
      const samples = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      return { samples, sampleRate, heardSpeech: heard }
    })()
    return finished
  }

  return { stop }
}

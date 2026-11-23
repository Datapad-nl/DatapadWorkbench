import type { VoiceLanguage, VoiceSettings } from '../../../shared/types'
import type { VoiceHelperApi, VoiceHelperJob } from '../../../shared/voiceHelper'
import { resample, speakableText, speechLanguage, speechSpeed, splitSpeakChunks, voiceId } from '../voice/engine'
import { oggOpusFile } from '../voice/oggOpus'

/**
 * The voice helper page: no window shows it. It turns Telegram voice notes into text and replies into
 * Ogg Opus voice memos, one job at a time, for src/main/voiceHelper.ts.
 */

const helper = (window as unknown as { voiceHelper: VoiceHelperApi }).voiceHelper

const ASR_RATE = 16000
const OPUS_RATE = 48000
/** About a minute and a half of speech. */
const SPOKEN_MAX = 1500
const CUT_NOTE = 'The rest is in the text.'
/** Between the chunks the model speaks one at a time. */
const GAP_SECONDS = 0.2

function onWorker<T>(worker: Worker, message: unknown, transfer: Transferable[], read: (data: unknown) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { error?: string; type?: string; message?: string }
      if (data.error !== undefined || data.type === 'error') {
        done()
        reject(new Error(data.error ?? data.message ?? 'Speech failed'))
        return
      }
      const value = read(data)
      if (value === undefined) return
      done()
      resolve(value)
    }
    const onError = (event: ErrorEvent): void => {
      done()
      reject(new Error(event.message || 'Speech worker failed'))
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage(message, transfer)
  })
}

let asrWorker: Worker | null = null
let ttsWorker: Promise<Worker> | null = null

async function transcribe(bytes: Uint8Array): Promise<string> {
  // Decoding at 16 kHz resamples too. Chromium reads Ogg Opus, MP3, M4A and WAV this way.
  const decoded = await new OfflineAudioContext(1, 1, ASR_RATE).decodeAudioData(bytes.slice().buffer)
  const audio = new Float32Array(decoded.length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel)
    for (let i = 0; i < data.length; i++) audio[i] += data[i] / decoded.numberOfChannels
  }
  asrWorker ??= new Worker(new URL('../voice/asr.worker.ts', import.meta.url), { type: 'module' })
  return onWorker(asrWorker, { id: 1, audio, multilingual: true }, [audio.buffer], (data) => (data as { text?: string }).text)
}

function tts(): Promise<Worker> {
  ttsWorker ??= (async () => {
    const worker = new Worker(new URL('../voice/asideTts.worker.ts', import.meta.url), { type: 'module' })
    await onWorker(worker, { type: 'load' }, [], (data) => ((data as { type: string }).type === 'ready' ? true : undefined))
    return worker
  })()
  ttsWorker.catch(() => {
    ttsWorker = null
  })
  return ttsWorker
}

async function synth(text: string, lang: VoiceLanguage, voice: VoiceSettings): Promise<Float32Array> {
  const worker = await tts()
  const message = { type: 'synth', id: 1, text, lang, voice: voiceId(voice), speed: speechSpeed(voice) }
  const audio = await onWorker(worker, message, [], (data) => {
    const reply = data as { type: string; samples?: Float32Array; sampleRate?: number }
    return reply.type === 'audio' ? reply : undefined
  })
  return resample(audio.samples as Float32Array, audio.sampleRate as number, OPUS_RATE)
}

/** The text cut at the last sentence end, or word, before `max`. */
function cutSpoken(text: string, max: number): string {
  const head = text.slice(0, max)
  const sentence = head.search(/[.!?…](?=[^.!?…]*$)/)
  if (sentence > max / 2) return head.slice(0, sentence + 1)
  const space = head.lastIndexOf(' ')
  return space > 0 ? head.slice(0, space) : head
}

async function speak(text: string, voice: VoiceSettings): Promise<Uint8Array> {
  let spoken = speakableText(text)
  if (!spoken) throw new Error('Nothing to speak')
  const cut = spoken.length > SPOKEN_MAX
  if (cut) spoken = cutSpoken(spoken, SPOKEN_MAX)
  const lang = speechLanguage(spoken, voice)
  const parts: Float32Array[] = []
  for (const chunk of splitSpeakChunks(spoken)) parts.push(await synth(chunk, lang, voice))
  if (cut) parts.push(await synth(CUT_NOTE, 'en', voice))
  const gap = Math.round(GAP_SECONDS * OPUS_RATE)
  const pcm = new Float32Array(parts.reduce((sum, part) => sum + part.length + gap, 0))
  let offset = 0
  for (const part of parts) {
    pcm.set(part, offset)
    offset += part.length + gap
  }
  return encodeOpus(pcm)
}

/** 48 kHz mono samples as an Ogg Opus file, with the browser's Opus encoder. */
async function encodeOpus(pcm: Float32Array): Promise<Uint8Array> {
  const config: AudioEncoderConfig = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: 32_000 }
  if (!(await AudioEncoder.isConfigSupported(config)).supported) throw new Error('This system has no Opus encoder')
  const packets: Uint8Array[] = []
  let preSkip = 312
  let failure: Error | null = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description
      if (description) {
        const head = new Uint8Array(ArrayBuffer.isView(description) ? description.buffer : description)
        // An OpusHead from the encoder carries its own pre-skip.
        if (head.length >= 19 && new TextDecoder().decode(head.subarray(0, 8)) === 'OpusHead') {
          preSkip = new DataView(head.buffer, head.byteOffset).getUint16(10, true)
        }
      }
      const packet = new Uint8Array(chunk.byteLength)
      chunk.copyTo(packet)
      packets.push(packet)
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error))
    }
  })
  encoder.configure(config)
  const frame = OPUS_RATE
  for (let start = 0; start < pcm.length; start += frame) {
    const data = pcm.slice(start, start + frame)
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: Math.round((start / OPUS_RATE) * 1_000_000),
      data
    })
    encoder.encode(audio)
    audio.close()
  }
  await encoder.flush()
  encoder.close()
  if (failure) throw failure
  return oggOpusFile({
    packets,
    preSkip,
    inputSampleRate: OPUS_RATE,
    totalSamples: pcm.length,
    serial: (Math.random() * 0x1_0000_0000) >>> 0
  })
}

async function run(job: VoiceHelperJob): Promise<void> {
  try {
    if (job.kind === 'transcribe') helper.done({ id: job.id, text: await transcribe(job.audio) })
    else helper.done({ id: job.id, ogg: await speak(job.text, job.voice) })
  } catch (error) {
    helper.done({ id: job.id, error: error instanceof Error ? error.message : String(error) })
  }
}

// The main process sends one job at a time.
helper.onJob((job) => void run(job))

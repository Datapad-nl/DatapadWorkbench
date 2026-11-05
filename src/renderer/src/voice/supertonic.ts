import * as ort from 'onnxruntime-web'
import type { VoiceLanguage } from '../../../shared/types'
import { ortMjs, ortWasm } from './ortAssets'

/**
 * Supertonic 3 on onnxruntime-web, after Supertone's own web helper.
 * The model reads text wrapped in a language tag; `na` lets it handle any language.
 */

const SUPERTONIC_ID = 'supertone-oss-archive/supertonic-3'
const BASE = `workbench-model://models/${SUPERTONIC_ID}`
const STEPS = 5

type Config = { ae: { sample_rate: number; base_chunk_size: number }; ttl: { latent_dim: number; chunk_compress_factor: number } }
type Style = { ttl: ort.Tensor; dp: ort.Tensor }
type Model = {
  config: Config
  indexer: number[]
  dp: ort.InferenceSession
  encoder: ort.InferenceSession
  estimator: ort.InferenceSession
  vocoder: ort.InferenceSession
}

let model: Promise<Model> | null = null
const styles = new Map<string, Promise<Style>>()

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}/${path}`)
  if (!response.ok) throw new Error(`Could not read ${path} (${response.status})`)
  return (await response.json()) as T
}

function loadModel(): Promise<Model> {
  if (model) return model
  model = (async () => {
    ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] }
    const session = (name: string): Promise<ort.InferenceSession> =>
      ort.InferenceSession.create(`${BASE}/onnx/${name}.onnx`, options)
    // One at a time keeps the peak memory of loading the large estimator down.
    const dp = await session('duration_predictor')
    const encoder = await session('text_encoder')
    const estimator = await session('vector_estimator')
    const vocoder = await session('vocoder')
    const [config, indexer] = await Promise.all([
      fetchJson<Config>('onnx/tts.json'),
      fetchJson<number[]>('onnx/unicode_indexer.json')
    ])
    return { config, indexer, dp, encoder, estimator, vocoder }
  })()
  model.catch(() => {
    model = null
  })
  return model
}

type StyleFile = { style_ttl: { data: unknown[]; dims: number[] }; style_dp: { data: unknown[]; dims: number[] } }

function loadStyle(voice: string): Promise<Style> {
  let style = styles.get(voice)
  if (!style) {
    style = fetchJson<StyleFile>(`voice_styles/${voice}.json`).then((file) => ({
      ttl: new ort.Tensor('float32', Float32Array.from(file.style_ttl.data.flat(Infinity) as number[]), file.style_ttl.dims),
      dp: new ort.Tensor('float32', Float32Array.from(file.style_dp.data.flat(Infinity) as number[]), file.style_dp.dims)
    }))
    style.catch(() => styles.delete(voice))
    styles.set(voice, style)
  }
  return style
}

const REPLACEMENTS: Array<[string, string]> = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['_', ' '],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['´', "'"], ['`', "'"],
  ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' '],
  ['@', ' at '], ['e.g.,', 'for example, '], ['i.e.,', 'that is, ']
]

function prepareText(raw: string, lang: VoiceLanguage): string {
  let text = raw.normalize('NFKD').replace(/\p{Extended_Pictographic}/gu, '')
  for (const [from, to] of REPLACEMENTS) text = text.replaceAll(from, to)
  text = text
    .replace(/[♥☆♡©\\]/g, '')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.'
  return `<${lang}>${text}</${lang}>`
}

/** Standard normal noise, Box-Muller. */
function gaussian(): number {
  const u1 = Math.max(0.0001, Math.random())
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random())
}

export async function loadSupertonic(): Promise<void> {
  await loadModel()
}

/** Mono PCM for one chunk of text. */
export async function synthesize(
  text: string,
  lang: VoiceLanguage,
  voice: string,
  speed: number
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const [m, style] = await Promise.all([loadModel(), loadStyle(voice)])
  const chars = Array.from(prepareText(text, lang))
  const ids = new BigInt64Array(chars.length)
  chars.forEach((char, i) => {
    const code = char.codePointAt(0) ?? 0
    ids[i] = BigInt(code < m.indexer.length ? m.indexer[code] : -1)
  })
  const textIds = new ort.Tensor('int64', ids, [1, chars.length])
  const textMask = new ort.Tensor('float32', new Float32Array(chars.length).fill(1), [1, 1, chars.length])

  const { duration } = await m.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })
  const seconds = (duration.data as Float32Array)[0] / speed
  const { text_emb: textEmb } = await m.encoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask })

  const { sample_rate: sampleRate, base_chunk_size: baseChunk } = m.config.ae
  const compress = m.config.ttl.chunk_compress_factor
  const chunk = baseChunk * compress
  const latentLen = Math.max(1, Math.ceil(Math.floor(seconds * sampleRate) / chunk))
  const latentDim = m.config.ttl.latent_dim * compress
  let latent = new Float32Array(latentDim * latentLen)
  for (let i = 0; i < latent.length; i++) latent[i] = gaussian()
  const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen])
  const totalStep = new ort.Tensor('float32', new Float32Array([STEPS]), [1])

  for (let step = 0; step < STEPS; step++) {
    const out = await m.estimator.run({
      noisy_latent: new ort.Tensor('float32', latent, [1, latentDim, latentLen]),
      text_emb: textEmb,
      style_ttl: style.ttl,
      latent_mask: latentMask,
      text_mask: textMask,
      current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
      total_step: totalStep
    })
    latent = new Float32Array(out.denoised_latent.data as Float32Array)
  }

  const { wav_tts: wav } = await m.vocoder.run({
    latent: new ort.Tensor('float32', latent, [1, latentDim, latentLen])
  })
  // The vocoder pads to whole latent chunks. Trim to the predicted length.
  const length = Math.min(wav.data.length, Math.floor(seconds * sampleRate))
  return { samples: new Float32Array((wav.data as Float32Array).subarray(0, length)), sampleRate }
}

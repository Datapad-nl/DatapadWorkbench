/** Whisper speech recognition, shared by the recognition worker and the UI-thread fallback. */

export type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>

// Whisper hears 30 s at a time, and drops the rest of longer audio unless the pipeline cuts it into
// overlapping windows. Audio of 30 s or less is still one window, as without these.
export const ASR_OPTIONS = { chunk_length_s: 30, stride_length_s: 5 }

let asr: AsrPipeline | null = null
let asrLoading: Promise<AsrPipeline> | null = null
let transformersReady: Promise<typeof import('@huggingface/transformers')> | null = null

async function transformersEnv(): Promise<typeof import('@huggingface/transformers')> {
  if (transformersReady) return transformersReady
  const ready = (async () => {
    const [tf, { ortMjs, ortWasm }] = await Promise.all([
      import('@huggingface/transformers'),
      import('./ortAssets')
    ])
    tf.env.allowRemoteModels = false
    tf.env.allowLocalModels = true
    tf.env.useBrowserCache = false
    tf.env.localModelPath = 'workbench-model://models/'
    const onnxWasm = tf.env.backends.onnx.wasm as { wasmPaths?: { mjs: string; wasm: string } } | undefined
    if (onnxWasm) {
      onnxWasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
    }
    return tf
  })()
  transformersReady = ready
  ready.catch(() => {
    if (transformersReady === ready) transformersReady = null
  })
  return ready
}

export async function getAsr(): Promise<AsrPipeline> {
  if (asr) return asr
  if (asrLoading) return asrLoading
  asrLoading = (async () => {
    const { pipeline } = await transformersEnv()
    const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      device: 'wasm',
      // Keyed by file name. These match the files src/main/voice.ts downloads.
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    })
    asr = ((audio, options) => pipe(audio, options)) as AsrPipeline
    return asr
  })()
  try {
    return await asrLoading
  } catch (error) {
    asrLoading = null
    throw error
  }
}

type Whisper = AsrPipeline & {
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array } }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> }
  }
}

let multilingual: Promise<Whisper> | null = null

/** Telegram voice notes may be Dutch or English, so they get a multilingual model: VOICE_NOTE_PACK in src/main/voice.ts. */
function getMultilingualAsr(): Promise<Whisper> {
  multilingual ??= (async () => {
    const { pipeline } = await transformersEnv()
    // On the GPU a 10 s note takes seconds; on wasm, with one thread here, over a minute. The same files serve both.
    const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu
    const adapter = await gpu?.requestAdapter().catch(() => null)
    const pipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
      device: adapter ? 'webgpu' : 'wasm',
      // Keyed by file name. These match VOICE_NOTE_PACK.
      dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }
    })
    return pipe as unknown as Whisper
  })()
  multilingual.catch(() => {
    multilingual = null
  })
  return multilingual
}

/**
 * The language Whisper hears in the first 30 s: its most likely language token after <|startoftranscript|>.
 * transformers.js does not detect it and would read everything as English.
 */
async function detectLanguage(pipe: Whisper, audio: Float32Array): Promise<string> {
  const { Tensor } = await transformersEnv()
  const { input_features } = await pipe.processor(audio.subarray(0, 16000 * 30))
  const config = pipe.model.generation_config
  const start = new Tensor('int64', BigInt64Array.from([BigInt(config.decoder_start_token_id)]), [1, 1])
  const { logits } = await pipe.model({ input_features, decoder_input_ids: start })
  let best = 'en'
  let top = -Infinity
  for (const [token, id] of Object.entries(config.lang_to_id)) {
    if (logits.data[id] > top) {
      top = logits.data[id]
      best = token.slice(2, -2)
    }
  }
  return best
}

/** 16 kHz mono speech in any language Whisper knows, as text. */
export async function transcribeAnyLanguage(audio: Float32Array): Promise<string> {
  const pipe = await getMultilingualAsr()
  const language = await detectLanguage(pipe, audio)
  const result = await pipe(audio, { ...ASR_OPTIONS, language, task: 'transcribe' })
  return result.text ?? ''
}

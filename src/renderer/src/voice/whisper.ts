/** Whisper speech recognition, shared by the recognition worker and the UI-thread fallback. */

export type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>

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

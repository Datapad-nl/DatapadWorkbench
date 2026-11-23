import { ASR_OPTIONS, getAsr, transcribeAnyLanguage } from './whisper'

/** `multilingual` is for Telegram voice notes; the voice mode hears English. */
type InMessage = { id: number; audio: Float32Array; multilingual?: boolean }
type OutMessage = { id: number; text: string } | { id: number; error: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null
  postMessage: (message: OutMessage) => void
}

let chain: Promise<unknown> = Promise.resolve()

scope.onmessage = (event) => {
  const { id, audio, multilingual } = event.data
  chain = chain.then(async () => {
    try {
      if (multilingual) {
        scope.postMessage({ id, text: await transcribeAnyLanguage(audio) })
        return
      }
      const pipe = await getAsr()
      const result = await pipe(audio, ASR_OPTIONS)
      scope.postMessage({ id, text: result.text ?? '' })
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'Speech recognition failed' })
    }
  })
}

import { getAsr } from './whisper'

type InMessage = { id: number; audio: Float32Array }
type OutMessage = { id: number; text: string } | { id: number; error: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null
  postMessage: (message: OutMessage) => void
}

let chain: Promise<unknown> = Promise.resolve()

scope.onmessage = (event) => {
  const { id, audio } = event.data
  chain = chain.then(async () => {
    try {
      const pipe = await getAsr()
      const result = await pipe(audio)
      scope.postMessage({ id, text: result.text ?? '' })
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'Speech recognition failed' })
    }
  })
}

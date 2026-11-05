import type { VoiceLanguage } from '../../../shared/types'
import { loadSupertonic, synthesize } from './supertonic'

type InMessage =
  | { type: 'load' }
  | { type: 'synth'; id: number; text: string; lang: VoiceLanguage; voice: string; speed: number; urgent?: boolean }

type OutMessage =
  | { type: 'ready' }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id?: number; message: string }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<InMessage>) => void) | null
  postMessage: (message: OutMessage, transfer?: Transferable[]) => void
}

function fail(id: number | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Status voice failed'
  scope.postMessage(id === undefined ? { type: 'error', message } : { type: 'error', id, message })
}

type Task = () => Promise<void>

// One model serves replies and status lines. A status line goes ahead of reply sentences still waiting.
const urgentTasks: Task[] = []
const tasks: Task[] = []
let running = false

function enqueue(task: Task, urgent = false): void {
  ;(urgent ? urgentTasks : tasks).push(task)
  void pump()
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (let task = urgentTasks.shift() ?? tasks.shift(); task; task = urgentTasks.shift() ?? tasks.shift()) {
      await task()
    }
  } finally {
    running = false
  }
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'load') {
    enqueue(async () => {
      try {
        await loadSupertonic()
        scope.postMessage({ type: 'ready' })
      } catch (error) {
        fail(undefined, error)
      }
    })
    return
  }
  enqueue(async () => {
    try {
      const { samples, sampleRate } = await synthesize(message.text, message.lang, message.voice, message.speed)
      if (samples.length === 0) {
        fail(message.id, new Error('Status voice returned no audio'))
        return
      }
      scope.postMessage({ type: 'audio', id: message.id, samples, sampleRate }, [samples.buffer])
    } catch (error) {
      fail(message.id, error)
    }
  }, message.urgent)
}

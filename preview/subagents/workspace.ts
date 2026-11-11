import { useSyncExternalStore } from 'react'

type Message = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
type Worker = { id: string; title: string; model: string; agent: 'claude'; createdAt: string; updatedAt: string; messages: Message[] }
type Stream = { status: 'idle' | 'streaming' | 'error'; draft: string; error: string | null }

export const ORCHESTRATOR = 'orchestrator'

type State = {
  workers: Worker[]
  streams: Record<string, Stream>
  permissions: Record<string, object>
}

const empty = (): State => ({ workers: [], streams: {}, permissions: {} })
let state = empty()
const listeners = new Set<() => void>()

/** Replaces the state the panel reads. The script calls this at each step. */
export function change(next: (current: State) => State): void {
  state = next(state)
  listeners.forEach((listener) => listener())
}

export function reset(): void {
  change(empty)
}

function useStore(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}

export function useWorkspace(): unknown {
  const { workers, permissions } = useStore()
  return {
    chats: workers.map((worker) => ({
      ...worker,
      parentChatId: ORCHESTRATOR,
      messageCount: worker.messages.length
    })),
    chatsById: {
      ...Object.fromEntries(workers.map((worker) => [worker.id, worker])),
      [ORCHESTRATOR]: { id: ORCHESTRATOR, agent: 'claude', conductor: true, messages: [] }
    },
    settings: { orchestratorModel: 'opus', claudeModel: '' },
    permissions,
    questions: {},
    openChat: () => {}
  }
}

export function useStreams(): Record<string, Stream> {
  return useStore().streams
}

export function useStreamStatuses(): Record<string, Stream> {
  return useStore().streams
}

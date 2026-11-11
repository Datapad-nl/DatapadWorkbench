export type WorkerState = 'needs-you' | 'working' | 'error' | 'reported' | 'waiting'

/** Where a subagent stands, as its orchestrator's chat shows it. */
export function workerState(input: {
  status: 'idle' | 'streaming' | 'error' | undefined
  needsUser: boolean
  messageCount: number
}): WorkerState {
  // A worker that asks for permission is still mid-turn, so the question comes first.
  if (input.needsUser) return 'needs-you'
  if (input.status === 'streaming') return 'working'
  if (input.status === 'error') return 'error'
  // A task and its answer make two messages. Fewer means it has not reported yet.
  return input.messageCount >= 2 ? 'reported' : 'waiting'
}

export const WORKER_STATE_LABEL: Record<WorkerState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  error: 'Failed',
  reported: 'Reported back',
  waiting: 'Not started'
}

const SUMMARY_ORDER: { state: WorkerState; word: string }[] = [
  { state: 'needs-you', word: 'need you' },
  { state: 'working', word: 'working' },
  { state: 'error', word: 'failed' },
  { state: 'reported', word: 'reported back' },
  { state: 'waiting', word: 'not started' }
]

/** "2 working · 1 reported back", leaving out the states no worker is in. */
export function workersSummary(states: WorkerState[]): string {
  return SUMMARY_ORDER.flatMap(({ state, word }) => {
    const count = states.filter((item) => item === state).length
    if (count === 0) return []
    return [`${count} ${state === 'needs-you' && count === 1 ? 'needs you' : word}`]
  }).join(' · ')
}

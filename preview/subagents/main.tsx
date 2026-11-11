import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SubagentsPanel } from '../../src/renderer/src/components/SubagentsPanel'
import '../../src/renderer/src/styles/globals.css'
import { ORCHESTRATOR, change, reset } from './workspace'

// The panel asks the app for the activity feed. Here the script is the feed.
const feed = new Set<(update: unknown) => void>()
const steps = new Map<string, unknown>()
Object.assign(window, {
  workbench: {
    getActivity: async () => ({ events: [...steps.values()] }),
    onActivityEvent: (listener: (update: unknown) => void) => {
      feed.add(listener)
      return () => feed.delete(listener)
    },
    getChat: async () => null,
    openMedia: async () => {}
  }
})

let stamp = 0
const at = (): string => new Date(Date.now() + stamp++).toISOString()

function doing(chatId: string, title: string): void {
  const event = { id: `${chatId}:now`, at: at(), chatId, kind: 'tool', title, status: 'running' }
  steps.set(event.id, event)
  feed.forEach((listener) => listener({ type: 'event', event }))
}

function stream(chatId: string, status: 'idle' | 'streaming', draft = ''): void {
  change((current) => ({ ...current, streams: { ...current.streams, [chatId]: { status, draft, error: null } } }))
}

function say(chatId: string, role: 'user' | 'assistant', content: string): void {
  change((current) => ({
    ...current,
    workers: current.workers.map((worker) =>
      worker.id === chatId
        ? {
            ...worker,
            updatedAt: at(),
            messages: [...worker.messages, { id: `${chatId}:${worker.messages.length}`, role, content, createdAt: at() }]
          }
        : worker
    )
  }))
}

/** The orchestrator hands a task to a new subagent. */
function delegate(id: string, title: string, model: string, task: string): void {
  change((current) => ({
    ...current,
    workers: [...current.workers, { id, title, model, createdAt: at(), updatedAt: at(), messages: [] }]
  }))
  say(id, 'user', task)
  stream(id, 'streaming')
}

function report(id: string, text: string): void {
  say(id, 'assistant', text)
  stream(id, 'idle')
}

function nudge(id: string, text: string): void {
  say(id, 'user', text)
  stream(id, 'streaming')
}

function needsYou(id: string, waiting: boolean): void {
  change((current) => {
    const permissions = { ...current.permissions }
    if (waiting) permissions[id] = {}
    else delete permissions[id]
    return { ...current, permissions }
  })
}

const SCRIPT: [number, () => void][] = [
  [0, () => stream(ORCHESTRATOR, 'streaming')],
  [1500, () => delegate('a', 'Map the release workflow', 'opus', 'Read .github/workflows/release.yml and electron-builder.yml. Report every step between a pushed tag and a published release, and where it can stall.')],
  [1700, () => doing('a', 'Read .github/workflows/release.yml')],
  [2400, () => delegate('b', 'Write the panel tests', 'sonnet', 'Write vitest tests for workerState and workersSummary in src/renderer/src/subagents.ts. Cover every state. Run them and report the result.')],
  [2600, () => doing('b', 'Read src/renderer/src/subagents.ts')],
  [3300, () => delegate('c', 'Rename the settings keys', 'haiku', 'Rename subagentModel to workerModel in the docs only. Do not touch code. Report the files you changed.')],
  [3500, () => doing('c', 'Search "subagentModel" in docs/')],
  [4200, () => stream(ORCHESTRATOR, 'idle')],
  [4600, () => doing('a', 'Read electron-builder.yml')],
  [5200, () => doing('b', 'Write src/renderer/src/subagents.test.ts')],
  [5800, () => doing('c', 'Edit docs/agent-tools.md')],
  [6600, () => doing('a', 'Run gh release list --limit 5')],
  [7400, () => doing('b', 'Run npx vitest run subagents')],
  [8200, () => stream('c', 'streaming', 'Renamed the key in one file')],
  [9000, () => report('c', 'Renamed the key in `docs/agent-tools.md`, 3 places. No other doc mentions it.')],
  [9200, () => stream(ORCHESTRATOR, 'streaming')],
  [10400, () => nudge('c', 'README.md also mentions subagentModel in the settings table. Rename it there too, then report again.')],
  [10600, () => doing('c', 'Edit README.md')],
  [11000, () => stream(ORCHESTRATOR, 'idle')],
  [11800, () => { needsYou('b', true); doing('b', 'Allow: npx vitest run') }],
  [12600, () => report('a', 'A pushed tag starts three builds. Each uploads its installer to a **draft** release. The new `publish` job then removes the draft flag. It can stall when one build fails: the release then stays a draft.')],
  [12800, () => stream(ORCHESTRATOR, 'streaming')],
  [14200, () => stream(ORCHESTRATOR, 'idle')],
  [15000, () => { needsYou('b', false); doing('b', 'Run npx vitest run subagents') }],
  [16200, () => report('c', 'Renamed it in `README.md` as well. Both docs now say `workerModel`.')],
  [16400, () => stream(ORCHESTRATOR, 'streaming')],
  [17600, () => stream('b', 'streaming', 'All 7 tests pass')],
  [18600, () => report('b', 'Wrote 7 tests in `src/renderer/src/subagents.test.ts`. All 7 pass.')],
  [20200, () => stream(ORCHESTRATOR, 'idle')]
]
const LENGTH = 24000

function Preview(): React.JSX.Element {
  const [run, setRun] = useState(0)
  useEffect(() => {
    reset()
    const timers = SCRIPT.map(([delay, step]) => window.setTimeout(step, delay))
    timers.push(window.setTimeout(() => setRun((value) => value + 1), LENGTH))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [run])

  return (
    <div className="flex h-full select-text flex-col overflow-hidden bg-canvas">
      <div className="mx-auto flex w-[min(720px,100%-40px)] items-center justify-between py-3 text-[12px] text-faint">
        <span>Preview: a scripted job with three subagents. It repeats.</span>
        <button
          type="button"
          className="rounded-[8px] px-2 py-1 text-muted hover:bg-hover hover:text-ink"
          onClick={() => setRun((value) => value + 1)}
        >
          Play again
        </button>
      </div>
      <div className="mx-auto w-[min(720px,100%-40px)] flex-1 overflow-y-auto pt-6 text-[14px] leading-6">
        <div className="ml-auto w-fit max-w-[80%] rounded-[12px] bg-raised px-3.5 py-2 text-ink">
          /conduct Find out why releases stay drafts, test the subagents panel, and rename the settings key in the docs.
        </div>
        <div className="mt-5 text-ink-2">
          Three independent tasks. I am handing each to its own subagent and will check what comes back.
        </div>
      </div>
      <SubagentsPanel chatId={ORCHESTRATOR} />
      <div className="mx-auto mb-4 h-[72px] w-[min(720px,100%-40px)] shrink-0 rounded-[12px] border border-line-strong bg-raised px-4 py-3 text-[13.5px] text-faint">
        Message the orchestrator
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

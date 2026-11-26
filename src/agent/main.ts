import { createAgent } from './server'

/**
 * The Workbench agent's process. As an Electron utility process it has no stdin, so the app sends ACP over
 * the parent port; under plain Node it reads stdin. What it says goes to stdout either way.
 */
type ParentPort = { on: (event: 'message', listener: (message: { data: string | null }) => void) => void }

const agent = createAgent((line) => void process.stdout.write(line), { home: process.env.WB_AGENT_HOME || undefined })

// One session's stray failure must not take the others down with it.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[agent] ${reason instanceof Error ? reason.message : String(reason)}\n`)
})

let ending = false
const end = (): void => {
  if (ending) return
  ending = true
  void agent.close().finally(() => process.exit(0))
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort
if (parentPort) {
  parentPort.on('message', ({ data }) => (data === null ? end() : agent.feed(data)))
} else {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => agent.feed(chunk))
  process.stdin.on('end', end)
}

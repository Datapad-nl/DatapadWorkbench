import { execFile } from 'child_process'
import { app, utilityProcess } from 'electron'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import { join, sep } from 'path'
import { type Readable, Writable } from 'stream'
import type { ClaudeCliInfo } from '../shared/types'

const TTL_MS = 60_000
const SIGNED_OUT: ClaudeCliInfo = { signedIn: false, subscription: null, email: null }

const INHERITED_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
]

let cached: ClaudeCliInfo | null = null
let cachedAt = 0
let inflight: Promise<ClaudeCliInfo> | null = null

export function claudeBinary(): string {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN
  for (const candidate of [join(homedir(), '.local', 'bin', 'claude'), join(homedir(), '.claude', 'local', 'claude')]) {
    if (existsSync(candidate)) return candidate
  }
  return 'claude'
}

/** A running agent: a child process, or the Claude adapter in a utility process made to look like one. */
export type AgentProcess = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  readonly killed: boolean
  kill(): boolean
  on(event: 'exit', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** A file the app ships unpacked next to the asar archive, because another process loads it by path. */
function unpackedPath(path: string): string {
  const unpacked = path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return unpacked !== path && existsSync(unpacked) ? unpacked : path
}

function hostScriptPath(): string {
  for (const candidate of [join(app.getAppPath(), 'src/main/claude-acp-host.mjs'), join(__dirname, 'claude-acp-host.mjs')]) {
    const path = unpackedPath(candidate)
    if (existsSync(path)) return path
  }
  throw new Error('The Claude Code host script is missing')
}

/**
 * Starts the ACP adapter that runs Claude Code on the user's own `claude auth login`. It runs in a utility
 * process rather than as Electron run as Node, which the app's fuses turn off.
 */
export async function startClaudeAdapter(): Promise<AgentProcess> {
  // In a packaged app the adapter and the Claude Code binary it launches must
  // be real files, so they ship unpacked next to the asar archive.
  const entry = unpackedPath(createRequire(__filename).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'))
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Started from inside a Claude Code session (a terminal agent, say), the app
  // inherits that session's markers. Drop them so chats are their own sessions.
  for (const key of INHERITED_SESSION_ENV) delete env[key]
  // Inherited from a shell, it would start the utility process's Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  // An API key in the environment wins over the claude.ai login and bills the
  // API account. With a subscription signed in, keep the run on the subscription.
  // Ask rather than trust the cache: the first chat after launch starts before anything filled it.
  const info = await getClaudeCliInfo().catch(() => null)
  if (info?.signedIn) delete env.ANTHROPIC_API_KEY
  return forkAgent(hostScriptPath(), entry, env)
}

/** A utility process behind the shape of a child process: its stdin goes over the parent port. */
function forkAgent(script: string, entry: string, env: NodeJS.ProcessEnv): AgentProcess {
  const child = utilityProcess.fork(script, [entry], { stdio: 'pipe', env, serviceName: 'Claude Code' })
  const events = new EventEmitter()
  let killed = false
  let spawned = false
  let exited = false
  // Messages wait for the process to start.
  const queue: Array<string | null> = []
  const post = (data: string | null): void => {
    if (exited || killed) return
    if (spawned) child.postMessage(data)
    else queue.push(data)
  }
  child.once('spawn', () => {
    spawned = true
    // A kill before the process had started could not reach it. It does now.
    if (killed) {
      child.kill()
      return
    }
    for (const data of queue.splice(0)) child.postMessage(data)
  })
  child.once('exit', () => {
    exited = true
    events.emit('exit')
  })
  // A fatal error in the adapter, such as running out of memory. Unheard, it would throw in the app.
  child.on('error', (type: string, location: string) => {
    events.emit('error', new Error(`${type} at ${location}`))
  })
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      post(chunk.toString())
      done()
    },
    final(done) {
      post(null)
      done()
    }
  })
  Object.defineProperty(events, 'killed', { get: () => killed })
  return Object.assign(events, {
    stdin,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
    kill() {
      if (exited || killed) return false
      killed = true
      queue.length = 0
      return spawned ? child.kill() : true
    }
  }) as unknown as AgentProcess
}

/** What the last probe found, however old. Null until one has finished. */
export function peekClaudeCliInfo(): ClaudeCliInfo | null {
  return cached
}

export async function getClaudeCliInfo(): Promise<ClaudeCliInfo> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached
  if (inflight) return inflight
  inflight = probe()
    .then((info) => {
      // A probe that timed out or printed nothing is not a sign-out. Keep the last answer and ask again next time.
      if (!info) return cached ?? SIGNED_OUT
      cached = info
      cachedAt = Date.now()
      return info
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** The CLI's answer, or null when it gave none. */
function probe(): Promise<ClaudeCliInfo | null> {
  return new Promise((resolve) => {
    execFile(
      claudeBinary(),
      ['auth', 'status'],
      { timeout: 8_000, encoding: 'utf8', maxBuffer: 64_000, env: process.env },
      (_error, stdout) => {
        try {
          const raw = JSON.parse(stdout) as {
            loggedIn?: unknown
            authMethod?: unknown
            subscriptionType?: unknown
            email?: unknown
          }
          if (raw.loggedIn !== true) {
            resolve(SIGNED_OUT)
            return
          }
          resolve({
            signedIn: true,
            subscription:
              typeof raw.subscriptionType === 'string' && raw.subscriptionType
                ? raw.subscriptionType
                : typeof raw.authMethod === 'string'
                  ? raw.authMethod
                  : null,
            email: typeof raw.email === 'string' ? raw.email : null
          })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

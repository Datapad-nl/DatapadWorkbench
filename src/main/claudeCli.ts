import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { homedir } from 'os'
import { join, sep } from 'path'
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

/** The ACP adapter that runs Claude Code on the user's own `claude auth login`. */
export async function claudeAcpCommand(): Promise<{
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}> {
  const resolved = createRequire(__filename).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
  // In a packaged app the adapter and the Claude Code binary it launches must
  // be real files, so they ship unpacked next to the asar archive.
  const unpacked = resolved.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  const entry = unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  // Started from inside a Claude Code session (a terminal agent, say), the app
  // inherits that session's markers. Drop them so chats are their own sessions.
  for (const key of INHERITED_SESSION_ENV) delete env[key]
  // An API key in the environment wins over the claude.ai login and bills the
  // API account. With a subscription signed in, keep the run on the subscription.
  // Ask rather than trust the cache: the first chat after launch starts before anything filled it.
  const info = await getClaudeCliInfo().catch(() => null)
  if (info?.signedIn) delete env.ANTHROPIC_API_KEY
  return { command: process.execPath, args: [entry], env }
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
      cached = info
      cachedAt = Date.now()
      return info
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function probe(): Promise<ClaudeCliInfo> {
  return new Promise((resolve) => {
    execFile(
      claudeBinary(),
      ['auth', 'status'],
      { timeout: 8_000, encoding: 'utf8', maxBuffer: 64_000, env: process.env },
      (_error, stdout) => {
        try {
          const raw = JSON.parse(stdout || '{}') as {
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
          resolve(SIGNED_OUT)
        }
      }
    )
  })
}

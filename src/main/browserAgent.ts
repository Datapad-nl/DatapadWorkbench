import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { agentHook } from './chatTools'
import { handleMcp, type Toolset } from './workbenchMcp'
import type { AcpMcpServer } from '../shared/mcp'

export const BROWSER_SESSION_RULE = [
  'You are inside Datapad Workbench.',
  'Open every web page in the Workbench BrowserPane using the `browser` MCP (`navigate`).',
  'That pane is the in-app browser: you can drive it immediately and verify your own UI work.',
  'Never launch Chrome, Safari, Playwright, Puppeteer, `open`, `xdg-open`, `start`, or any other external browser.',
  'After a UI change, navigate to the local URL, then call `screenshot` to see it and `snapshot` to read it. Use `click`, `type`, `press` and `wait_for` to try the change the way a user would, and `console` to check for errors.',
  'When the user shares a YouTube URL or asks to transcribe, summarize, or quote a YouTube video, call `transcribe_youtube` with that URL.',
  'Do not scrape the watch page for captions unless that tool fails.',
  'If you start a long-running dev server (`next dev`, vite, webpack) in a Datapad Workbench worktree, stop it when the task is done. Do not leave it running in the background.',
  'While a turn is running, keep the user posted in the reply itself.',
  'Before a long stretch of tool work, and again whenever you have been working without a new sentence the user can read, write one short sentence that says what you are doing now.',
  'For a long command, do not hide its output: if you also save a file, pipe through tee so each line still reaches the tool log. Print a progress line as the work advances, and flush it. Do not wait on one background task for the whole run; check its latest line and tell the user what it says.',
  'A long task may be started with /goal. While a goal is active, call update_goal with one short status sentence at each milestone.',
  'Do not mark the goal complete until the work is actually done, and do not go silent until the turn is finished.'
].join(' ')

let started: Promise<{ url: string }> | null = null

/**
 * One token per chat, so a call acts for the chat its token was given to. The token is the only proof of
 * who calls: nothing in a request names a chat.
 */
const chatTokens = new Map<string, string>()
const tokenChats = new Map<string, string>()

function tokenFor(chatId: string): string {
  let token = chatTokens.get(chatId)
  if (!token) {
    token = randomBytes(24).toString('hex')
    chatTokens.set(chatId, token)
    tokenChats.set(token, chatId)
  }
  return token
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

/** The chat whose token the request carries, or null. */
function callerOf(req: IncomingMessage): { token: string; chatId: string } | null {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  const chatId = tokenChats.get(token)
  return chatId === undefined ? null : { token, chatId }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    json(res, 403, { error: 'Local only' })
    return
  }
  const caller = callerOf(req)
  if (!caller) {
    json(res, 401, { error: 'Unauthorized' })
    return
  }

  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (req.method !== 'POST') {
    // No stream of its own from the server: everything comes back on the POST that asked.
    res.writeHead(405, { Allow: 'POST' }).end()
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJson(req)
  } catch {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }

  if (path === '/hooks/agent' && caller.chatId) {
    json(res, 200, await agentHook(caller.chatId, body))
    return
  }
  if (path === '/mcp/browser' || path === '/mcp/workbench') {
    await handleMcp(res, caller, path.slice('/mcp/'.length) as Toolset, body)
    return
  }

  json(res, 404, { error: 'Not found' })
}

export function startBrowserAgentServer(): Promise<{ url: string }> {
  if (started) return started
  const starting = new Promise<{ url: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res).catch((error) => {
        if (res.headersSent) res.end()
        else json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Browser agent server failed to bind'))
        return
      }
      resolve({ url: `http://127.0.0.1:${address.port}` })
    })
  })
  started = starting
  // A failed start is not kept, so the next caller tries again.
  starting.catch(() => {
    if (started === starting) started = null
  })
  return starting
}

/**
 * Claude Code settings that ask the app before each Agent tool call of `chatId`, so Settings holds for its own
 * agents too, and before each file edit, which a conductor chat is refused. The app decides at the call, so a
 * chat that becomes a conductor mid-session is held to it.
 */
export async function agentHookSettings(chatId: string): Promise<Record<string, unknown>> {
  const { url } = await startBrowserAgentServer()
  const hook = { type: 'http', url: `${url}/hooks/agent`, headers: { Authorization: `Bearer ${tokenFor(chatId)}` } }
  return { hooks: { PreToolUse: [{ matcher: 'Agent|Task|Edit|Write|MultiEdit|NotebookEdit', hooks: [hook] }] } }
}

/** The `browser` server, and the `workbench` chat tools (visuals, delegate, other chats) for `chatId`. */
export async function browserMcpServers(chatId?: string): Promise<AcpMcpServer[]> {
  const { url } = await startBrowserAgentServer()
  const headers = [{ name: 'Authorization', value: `Bearer ${tokenFor(chatId ?? '')}` }]
  return [
    { type: 'http', name: 'browser', url: `${url}/mcp/browser`, headers },
    { type: 'http', name: 'workbench', url: `${url}/mcp/workbench`, headers }
  ]
}

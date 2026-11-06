import { app } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { join, sep } from 'path'
import {
  getBrowserState,
  goBack,
  goForward,
  navigateBrowser,
  reloadBrowser,
  requestShowBrowser,
  stopBrowser
} from './browser'
import { click, consoleLog, evaluate, press, screenshot, snapshot, type, waitFor, type Target } from './browserDrive'
import { transcribeYoutube } from './youtube'
import {
  cancelProjectSchedule,
  delegateTask,
  listProjectChats,
  readProjectChat,
  scheduleTask,
  startProjectChat,
  waitForDelegate
} from './chatTools'
import { linkPr, prStatus, unlinkCallerPr } from './pullRequests'
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

let started: Promise<{ url: string; token: string }> | null = null

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

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function targetOf(body: Record<string, unknown>): Target | null {
  const target: Target = { ref: num(body.ref), selector: str(body.selector), text: str(body.text) }
  return target.ref == null && !target.selector && !target.text ? null : target
}

/** Tools that read or drive the open page. Each takes the JSON body and returns JSON. */
const DRIVE: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  '/screenshot': () => screenshot(),
  '/snapshot': (body) => snapshot(num(body.maxChars)),
  '/click': (body) => {
    const target = targetOf(body)
    if (!target) throw new Error('Pass ref, selector or text')
    return click(target)
  },
  '/type': (body) => {
    const field = targetOf({ ref: body.ref, selector: body.selector, text: body.field })
    return type(field, typeof body.text === 'string' ? body.text : '', body.clear === true)
  },
  '/press': (body) =>
    press(str(body.key) ?? '', Array.isArray(body.modifiers) ? body.modifiers.map(String) : []),
  '/wait_for': (body) => waitFor(str(body.selector), str(body.text), num(body.timeoutMs)),
  '/evaluate': async (body) => ({ result: await evaluate(str(body.expression) ?? 'undefined') }),
  '/console': async (body) => consoleLog(str(body.level), num(body.limit)),
  '/chats/list': (body) => listProjectChats(body.from),
  '/chats/read': (body) => readProjectChat(body),
  '/chats/start': (body) => startProjectChat(body),
  '/chats/delegate': (body) => delegateTask(body),
  '/chats/wait': (body) => waitForDelegate(body),
  '/chats/schedule': (body) => scheduleTask(body),
  '/chats/unschedule': (body) => cancelProjectSchedule(body),
  '/pr/link': (body) => linkPr(body),
  '/pr/status': (body) => prStatus(body),
  '/pr/unlink': (body) => unlinkCallerPr(body)
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? ''
  return header === `Bearer ${token}`
}

function mcpScriptPath(): string {
  const fromSrc = join(app.getAppPath(), 'src/main/browser-mcp.mjs')
  // A packaged app ships the script unpacked next to the asar archive.
  const unpacked = fromSrc.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  if (unpacked !== fromSrc && existsSync(unpacked)) return unpacked
  if (existsSync(fromSrc)) return fromSrc
  const fromOut = join(__dirname, 'browser-mcp.mjs')
  if (existsSync(fromOut)) return fromOut
  throw new Error('Workbench browser MCP script is missing')
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string
): Promise<void> {
  if (req.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    json(res, 403, { error: 'Local only' })
    return
  }
  if (!authorized(req, token)) {
    json(res, 401, { error: 'Unauthorized' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/state') {
    json(res, 200, getBrowserState())
    return
  }

  if (method === 'POST' && path === '/navigate') {
    let urlInput = ''
    try {
      const parsed = JSON.parse(await readBody(req)) as { url?: unknown }
      urlInput = typeof parsed.url === 'string' ? parsed.url : ''
    } catch {
      json(res, 400, { error: 'Invalid JSON' })
      return
    }
    requestShowBrowser()
    json(res, 200, await navigateBrowser(urlInput))
    return
  }

  if (method === 'POST' && path === '/back') {
    requestShowBrowser()
    json(res, 200, goBack())
    return
  }
  if (method === 'POST' && path === '/forward') {
    requestShowBrowser()
    json(res, 200, goForward())
    return
  }
  if (method === 'POST' && path === '/reload') {
    json(res, 200, reloadBrowser())
    return
  }
  if (method === 'POST' && path === '/stop') {
    json(res, 200, stopBrowser())
    return
  }

  const drive = method === 'POST' ? DRIVE[path] : undefined
  if (drive) {
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { error: 'Invalid JSON' })
      return
    }
    try {
      json(res, 200, await drive(body))
    } catch (error) {
      json(res, 422, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (method === 'POST' && path === '/youtube/transcript') {
    let urlInput = ''
    let lang: string | undefined
    try {
      const parsed = JSON.parse(await readBody(req)) as { url?: unknown; lang?: unknown }
      urlInput = typeof parsed.url === 'string' ? parsed.url : ''
      lang = typeof parsed.lang === 'string' ? parsed.lang : undefined
    } catch {
      json(res, 400, { error: 'Invalid JSON' })
      return
    }
    json(res, 200, await transcribeYoutube(urlInput, lang))
    return
  }

  json(res, 404, { error: 'Not found' })
}

export function startBrowserAgentServer(): Promise<{ url: string; token: string }> {
  if (started) return started
  const starting = new Promise<{ url: string; token: string }>((resolve, reject) => {
    const token = randomBytes(24).toString('hex')
    const server = createServer((req, res) => {
      void handle(req, res, token).catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
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
      resolve({ url: `http://127.0.0.1:${address.port}`, token })
    })
  })
  started = starting
  // A failed start is not kept, so the next caller tries again.
  starting.catch(() => {
    if (started === starting) started = null
  })
  return starting
}

/** The `browser` server, and the `workbench` chat tools (visuals, delegate, other chats) for `chatId`. */
export async function browserMcpServers(chatId?: string): Promise<AcpMcpServer[]> {
  const { url, token } = await startBrowserAgentServer()
  const env = [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'WORKBENCH_BROWSER_URL', value: url },
    { name: 'WORKBENCH_BROWSER_TOKEN', value: token }
  ]
  return [
    { type: 'stdio', name: 'browser', command: process.execPath, args: [mcpScriptPath()], env },
    {
      type: 'stdio',
      name: 'workbench',
      command: process.execPath,
      args: [mcpScriptPath()],
      env: [
        ...env,
        { name: 'WORKBENCH_TOOLSET', value: 'workbench' },
        { name: 'WORKBENCH_CHAT_ID', value: chatId ?? '' }
      ]
    }
  ]
}

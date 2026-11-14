import type { ServerResponse } from 'http'
import { getBrowserState, requestShowBrowser, stopBrowser } from './browser'
import {
  back,
  click,
  consoleLog,
  evaluate,
  forward,
  navigate,
  press,
  reload,
  screenshot,
  snapshot,
  type,
  waitFor,
  type Target
} from './browserDrive'
import { transcribeYoutube } from './youtube'
import {
  cancelProjectSchedule,
  delegateTask,
  handoffChat,
  listProjectChats,
  notifyFromBot,
  nudgeWorker,
  readProjectChat,
  scheduleTask,
  setFollowUp,
  startProjectChat,
  waitForDelegate
} from './chatTools'
import { linkPr, prStatus, unlinkCallerPr } from './pullRequests'
import { cancelSecret, requestSecret, waitForSecret } from './secretTools'
import { getChat } from './store'
import { BOT_RUN_TOOLS, BROWSER_TOOLS, WORKBENCH_TOOLS, type McpTool } from './workbenchMcpTools'

/**
 * The Workbench's own MCP servers, served over streamable HTTP from the main process. The agents connect to
 * them by URL, so no helper process runs Electron as Node. Each chat has its own token, and a tool acts for
 * the chat its token was given to: nothing in a call can name another chat.
 */

export type Toolset = 'browser' | 'workbench'
type Args = Record<string, unknown>
type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args }

/** How often a long tool call sends a comment down its stream, so no client or proxy takes it for dead. */
const KEEPALIVE_MS = 15_000

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function targetOf(args: Args): Target | null {
  const target: Target = { ref: num(args.ref), selector: str(args.selector), text: str(args.text) }
  return target.ref == null && !target.selector && !target.text ? null : target
}

/** Resolves when `signal` aborts, so a wait in progress ends at a cancel rather than after it. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('Cancelled'))
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
  })
}

async function delegate(
  start: Promise<unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const cancel = aborted(signal)
  cancel.catch(() => undefined)
  const started = (await Promise.race([start, cancel])) as { chatId: string; title?: string; model?: string }
  while (!signal.aborted) {
    const result = (await Promise.race([waitForDelegate({ chatId: started.chatId, ms: 60_000 }), cancel])) as {
      done?: boolean
    }
    if (result.done) return { ...result, chatId: started.chatId, title: started.title, model: started.model }
  }
  throw new Error('Cancelled')
}

async function secret(args: Args, from: string, signal: AbortSignal): Promise<unknown> {
  const { requestId } = await requestSecret({ ...args, from })
  const cancel = aborted(signal)
  cancel.catch(() => undefined)
  try {
    while (!signal.aborted) {
      const result = await Promise.race([waitForSecret({ requestId, ms: 60_000 }), cancel])
      if (result.done) return result
    }
    throw new Error('Cancelled')
  } finally {
    // The turn moved on without an answer: the password field closes and nothing is saved.
    if (signal.aborted) cancelSecret({ requestId })
  }
}

async function workbenchTool(name: string, args: Args, from: string, signal: AbortSignal): Promise<unknown> {
  if (name === 'show_visual') {
    // The app picks the HTML up from the tool call itself and draws it in the chat.
    if (!String(args.html ?? '').trim()) throw new Error('Pass the HTML to show.')
    return { shown: true }
  }
  if (name === 'delegate') return delegate(delegateTask({ ...args, from }), signal)
  if (name === 'nudge') return delegate(nudgeWorker({ ...args, from }), signal)
  if (name === 'list_chats') return listProjectChats(from)
  if (name === 'read_chat') return readProjectChat({ ...args, from })
  if (name === 'start_chat') return startProjectChat({ ...args, from })
  if (name === 'handoff') return handoffChat({ ...args, from })
  if (name === 'schedule_task') return scheduleTask({ ...args, from })
  if (name === 'cancel_schedule') return cancelProjectSchedule({ ...args, from })
  if (name === 'link_pr') return linkPr({ ...args, from })
  if (name === 'pr_status') return prStatus({ ...args, from })
  if (name === 'unlink_pr') return unlinkCallerPr({ from })
  if (name === 'request_secret') return secret(args, from, signal)
  if (name === 'notify') return notifyFromBot({ ...args, from })
  if (name === 'follow_up') return setFollowUp({ ...args, from })
  throw new Error(`Unknown tool: ${name}`)
}

/** The workbench tools of a chat: a bot's own chat also has the tools of its unattended runs. */
async function workbenchTools(chatId: string): Promise<McpTool[]> {
  const chat = await getChat(chatId).catch(() => null)
  return chat?.botId && !chat.projectId ? [...WORKBENCH_TOOLS, ...BOT_RUN_TOOLS] : WORKBENCH_TOOLS
}

async function browserTool(name: string, args: Args): Promise<unknown> {
  if (name === 'get_state') return getBrowserState()
  if (name === 'navigate') {
    requestShowBrowser()
    return navigate(String(args.url ?? ''))
  }
  if (name === 'back') {
    requestShowBrowser()
    return back()
  }
  if (name === 'forward') {
    requestShowBrowser()
    return forward()
  }
  if (name === 'reload') return reload()
  if (name === 'stop') return stopBrowser()
  if (name === 'screenshot') return screenshot()
  if (name === 'snapshot') return snapshot(num(args.maxChars))
  if (name === 'click') {
    const target = targetOf(args)
    if (!target) throw new Error('Pass ref, selector or text')
    return click(target)
  }
  if (name === 'type') {
    const field = targetOf({ ref: args.ref, selector: args.selector, text: args.field })
    return type(field, typeof args.text === 'string' ? args.text : '', args.clear === true)
  }
  if (name === 'press') return press(str(args.key) ?? '', Array.isArray(args.modifiers) ? args.modifiers.map(String) : [])
  if (name === 'wait_for') return waitFor(str(args.selector), str(args.text), num(args.timeoutMs))
  if (name === 'evaluate') return { result: await evaluate(str(args.expression) ?? 'undefined') }
  if (name === 'console') return consoleLog(str(args.level), num(args.limit))
  if (name === 'transcribe_youtube') return transcribeYoutube(String(args.url ?? ''), str(args.lang))
  throw new Error(`Unknown tool: ${name}`)
}

function snapshotText(data: {
  title?: string
  url?: string
  text?: string
  elements?: Array<{
    ref: number
    role: string
    name: string
    value?: string
    checked?: boolean
    disabled?: boolean
    offscreen?: boolean
  }>
}): string {
  const lines = [`${data.title || '(no title)'} — ${data.url}`, '', data.text || '(no text)', '', 'Elements:']
  for (const el of data.elements ?? []) {
    let line = `[${el.ref}] ${el.role} "${el.name}"`
    if (el.value !== undefined) line += ` value="${el.value}"`
    if (el.checked !== undefined) line += el.checked ? ' (checked)' : ' (unchecked)'
    if (el.disabled) line += ' (disabled)'
    if (el.offscreen) line += ' (scrolled out of view)'
    lines.push(line)
  }
  if (!data.elements?.length) lines.push('(none)')
  return lines.join('\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toContent(name: string, data: any): Array<Record<string, unknown>> {
  if (name === 'screenshot') {
    return [
      { type: 'image', data: data.png, mimeType: 'image/png' },
      { type: 'text', text: `${data.width}×${data.height}` }
    ]
  }
  if (name === 'snapshot') return [{ type: 'text', text: snapshotText(data) }]
  if (name === 'show_visual') return [{ type: 'text', text: 'Shown in the chat.' }]
  if (name === 'delegate' || name === 'nudge') {
    const head = `${data.title} (${data.chatId})${data.model ? ` on ${data.model}` : ''}${data.worktreeBranch ? ` on branch ${data.worktreeBranch}` : ''}`
    if (data.error) return [{ type: 'text', text: `${head} stopped: ${data.error}\n\n${data.answer ?? ''}`.trim() }]
    return [{ type: 'text', text: `${head} finished.\n\n${data.answer || '(no answer)'}` }]
  }
  if (name === 'read_chat' || name === 'link_pr' || name === 'pr_status' || name === 'request_secret') {
    return [{ type: 'text', text: data.text }]
  }
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

/** Tool calls in flight, by token and request id, so a `notifications/cancelled` can stop one. */
const running = new Map<string, AbortController>()

/** Runs one tool for `chatId` and gives the MCP result. A failed tool is a result too, marked as an error. */
export async function callTool(
  toolset: Toolset,
  chatId: string,
  name: string,
  args: Args,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  try {
    const data =
      toolset === 'workbench' ? await workbenchTool(name, args, chatId, signal) : await browserTool(name, args)
    return { content: toContent(name, data) }
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Answers one POST of the MCP streamable HTTP transport. A tool call is answered as an event stream that
 * stays open while the tool runs (a delegate can run for hours) and carries the result as its one message.
 */
export async function handleMcp(
  res: ServerResponse,
  binding: { token: string; chatId: string },
  toolset: Toolset,
  body: unknown
): Promise<void> {
  // Batches left the protocol in 2025-06-18, and no client of ours sends one.
  if (Array.isArray(body)) {
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } })
    return
  }
  const message = (body && typeof body === 'object' ? body : {}) as JsonRpc
  const { id, method, params } = message
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result })

  if (method === 'initialize') {
    reply({
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: toolset === 'workbench' ? 'workbench' : 'workbench-browser', version: '0.2.0' }
    })
    return
  }
  if (method === 'notifications/cancelled') {
    running.get(`${binding.token}:${toolset}:${String(params?.requestId)}`)?.abort()
  }
  // Notifications and responses get no answer of their own.
  if (id === undefined || id === null) {
    res.writeHead(202).end()
    return
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') {
    return reply({ tools: toolset === 'workbench' ? await workbenchTools(binding.chatId) : BROWSER_TOOLS })
  }
  if (method !== 'tools/call') {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } })
    return
  }

  // Each toolset is its own connection with its own request ids.
  const key = `${binding.token}:${toolset}:${String(id)}`
  const abort = new AbortController()
  running.set(key, abort)
  // A client that hangs up has given up on the call.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
  try {
    const name = typeof params?.name === 'string' ? params.name : ''
    const args = params?.arguments && typeof params.arguments === 'object' ? (params.arguments as Args) : {}
    const result = await callTool(toolset, binding.chatId, name, args, abort.signal)
    // A cancelled request gets no reply.
    if (!abort.signal.aborted) res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
  } finally {
    clearInterval(keepalive)
    if (running.get(key) === abort) running.delete(key)
    res.end()
  }
}

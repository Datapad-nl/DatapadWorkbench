import { type ChildProcessWithoutNullStreams, spawn } from 'child_process'
import readline from 'readline'
import { toAcpMcpServers } from '../shared/mcp'
import { agentToolRule } from '../shared/conductor'
import { isToolAllowed, toolCallName } from '../shared/botTools'
import { BROWSER_SESSION_RULE, agentHookSettings, browserMcpServers } from './browserAgent'
import { claudeAcpCommand } from './claudeCli'
import { grokBinary } from './grokCli'
import { snapshotBeforeTool } from './checkpoints'
import {
  askPermission,
  cancelAllPermissions,
  cancelSessionPermissions,
  chatIdForSession,
  decidePermission,
  fallbackSessionId,
  findClash,
  isMutatingTool,
  isPlanGateTool,
  isSessionStopped,
  modeForSession,
  noteDeniedPermission,
  outcomeFor,
  pickOption,
  type PermissionOption,
  type PermissionParams
} from './permissions'
import {
  askUserQuestions,
  cancelAgentQuestions,
  cancelSessionQuestions,
  elicitationResult,
  isElicitationMethod,
  isUserQuestionMethod,
  looksLikeUserQuestion,
  parseAsk,
  skipOutcome
} from './questions'
import { tmpdir } from 'os'
import {
  normalizeReasoningEffort,
  type AgentCommand,
  type ChatAgent,
  type ClaudeOptions,
  type ReasoningEffort,
  type UsagePeriodKind,
  type UsageSnapshot
} from '../shared/types'
import {
  chatBot,
  claudeModelFor,
  getApiKey,
  getClaudeModel,
  getEffort,
  getMaxSubagents,
  getMcpServers,
  getSubagentModel,
  skipNewSession
} from './store'
import { readGrokPlan } from './sessions'

type JsonRpc = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string; code?: number }
}

export type SessionMode = {
  id: string
  name: string
  description?: string
}

export type ExitPlanOutcome = 'approved' | 'cancelled' | 'abandoned'

type ExitPlanParams = {
  sessionId?: string
  planContent?: string
  plan_content?: string
  plan?: string | { content?: string; markdown?: string }
  markdown?: string
  content?: string
}

type PendingExit = {
  id: number | string
  sessionId: string
  chatId: string
  markdown: string
  resolve: (outcome: ExitPlanOutcome) => void
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  method?: string
  sessionId?: string
}

export type SessionUpdate = {
  sessionId: string
  update: {
    sessionUpdate?: string
    content?: unknown
    title?: string
    kind?: string
    status?: string
    toolCallId?: string
    locations?: Array<{ path?: string; line?: number }>
    entries?: Array<{ content?: string; status?: string; priority?: string }>
    rawInput?: unknown
    rawOutput?: unknown
    _meta?: unknown
    name?: string
    currentModeId?: string
    modeId?: string
    message?: string
    objective?: string
    current_deliverable_title?: string
    currentDeliverableTitle?: string
    completed_deliverables?: number
    completedDeliverables?: number
    total_deliverables?: number
    totalDeliverables?: number
    availableCommands?: Array<{ name?: unknown; description?: unknown; input?: { hint?: unknown } | null }>
    /** Context use: Claude Code's `usage_update`, Grok's `turn_completed` and auto-compact notices. */
    used?: number
    size?: number
    usage?: { inputTokens?: number; modelCalls?: number }
    tokens_used?: number
    context_window?: number
    tokens_after?: number
  }
}

export function contentText(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map(contentText).filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join('') : null
  }
  if (typeof content !== 'object') return null
  const record = content as { text?: unknown; content?: unknown }
  if (typeof record.text === 'string') return record.text
  if (record.content !== undefined) return contentText(record.content)
  return null
}

const UPDATE_LISTENERS = new Set<(update: SessionUpdate) => void>()
const TASK_LISTENERS = new Set<(sessionId: string, message: unknown) => void>()
const EXIT_PLAN_LISTENERS = new Set<(input: { chatId: string; sessionId: string; markdown: string }) => void>()
const acpSessionModes = new Map<string, { current: string; available: SessionMode[] }>()
const acpSessionCommands = new Map<string, AgentCommand[]>()
const pendingExits = new Map<string, PendingExit>()
const queuedVerdicts = new Map<string, { outcome: ExitPlanOutcome; at: number }>()
/** A verdict given before the agent asked. Kept only briefly, so it cannot answer a later plan. */
const QUEUED_VERDICT_TTL_MS = 60_000
const SESSION_UPDATE_METHODS = new Set(['session/update', 'x.ai/session/update', '_x.ai/session/update'])

/**
 * Tool names by tool call id, from the tool call updates. Claude Code names an MCP tool in its permission request
 * but other tools only in the tool call that comes before it. Holds the latest calls only.
 */
const toolCallNames = new Map<string, string>()

function noteToolCallName(update: SessionUpdate['update'] | undefined): void {
  const kind = update?.sessionUpdate
  if ((kind !== 'tool_call' && kind !== 'tool_call_update') || !update?.toolCallId) return
  const name = toolCallName(update)
  if (!name) return
  toolCallNames.delete(update.toolCallId)
  toolCallNames.set(update.toolCallId, name)
  if (toolCallNames.size > 500) toolCallNames.delete(toolCallNames.keys().next().value as string)
}

/** Whether a bot chat may run this tool without asking, because the tool is on the bot's list. */
async function botAllowsTool(sessionId: string, params: PermissionParams): Promise<boolean> {
  const tool = params.toolCall
  const name = toolCallName(tool) ?? (tool?.toolCallId ? toolCallNames.get(tool.toolCallId) : undefined)
  if (!name) return false
  const bot = await chatBot(chatIdForSession(sessionId) ?? undefined).catch(() => null)
  return !!bot && isToolAllowed(bot.allowedTools, name)
}

/**
 * One ACP agent process. Grok Build and Claude Code each get their own, and so does every bot on
 * Grok Build, because Grok takes a bot's skills (`--plugin-dir`) for the whole process.
 */
type Conn = {
  agent: ChatAgent
  /** `grok`, `claude`, or `grok@<bot folder>`. */
  key: AgentKey
  pluginDir: string | null
  proc: ChildProcessWithoutNullStreams | null
  /** Counts spawns, so a timer can tell the process it meant from a respawn. */
  generation: number
  ready: Promise<void> | null
  nextId: number
  pending: Map<number, Pending>
  liveSessions: Set<string>
  inbound: JsonRpc[]
  flushScheduled: boolean
}

/** Names one agent process. A chat agent's own name is the key of its shared process. */
export type AgentKey = string

/** The process a session runs on: Claude Code takes a bot's skills per session, Grok per process. */
export function agentKey(agent: ChatAgent, pluginDir?: string | null): AgentKey {
  return agent === 'grok' && pluginDir ? `grok@${pluginDir}` : agent
}

function makeConn(agent: ChatAgent, pluginDir: string | null = null): Conn {
  return {
    agent,
    key: agentKey(agent, pluginDir),
    pluginDir: agent === 'grok' ? pluginDir : null,
    proc: null,
    generation: 0,
    ready: null,
    nextId: 1,
    pending: new Map(),
    liveSessions: new Set(),
    inbound: [],
    flushScheduled: false
  }
}

const conns = new Map<AgentKey, Conn>([
  ['grok', makeConn('grok')],
  ['claude', makeConn('claude')]
])
const grokConn = conns.get('grok') as Conn
const claudeConn = conns.get('claude') as Conn

function connFor(agent: ChatAgent, pluginDir?: string | null): Conn {
  const key = agentKey(agent, pluginDir)
  let conn = conns.get(key)
  if (!conn) {
    conn = makeConn(agent, pluginDir)
    conns.set(key, conn)
  }
  return conn
}

const sessionAgents = new Map<string, ChatAgent>()
/** The process of each session, when it is not its agent's shared one. */
const sessionConns = new Map<string, Conn>()
/** The chat of each session, for the model that chat runs on. */
const sessionChatIds = new Map<string, string>()

/** Claude Code's ExitPlanMode arrives as a permission request with these option ids. */
const CLAUDE_EXIT_PLAN_OPTION = 'exit-plan-'
const CLAUDE_EXIT_PLAN_APPROVE = 'exit-plan-default'

export function agentForSession(sessionId: string): ChatAgent {
  return sessionAgents.get(sessionId) ?? 'grok'
}

function connForSession(sessionId: string): Conn {
  return sessionConns.get(sessionId) ?? connFor(agentForSession(sessionId))
}

function bindSession(sessionId: string, conn: Conn): void {
  sessionAgents.set(sessionId, conn.agent)
  if (conn.pluginDir) sessionConns.set(sessionId, conn)
  else sessionConns.delete(sessionId)
}

/** Request ids from two processes can collide, so all but the shared Grok one get a prefix. */
function promptRequestId(conn: Conn, id: number | string): string {
  return conn.key === 'grok' ? String(id) : `${conn.key}:${id}`
}

async function spawnAgent(agent: ChatAgent, pluginDir?: string | null): Promise<ChildProcessWithoutNullStreams> {
  if (agent === 'claude') {
    const { command, args, env } = await claudeAcpCommand()
    return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
  }
  const plugin = pluginDir ? ['--plugin-dir', pluginDir] : []
  return spawn(grokBinary(), ['agent', '--no-leader', ...plugin, 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  })
}

function isClaudeExitPlan(options: PermissionOption[]): boolean {
  return options.some((option) => option.optionId.startsWith(CLAUDE_EXIT_PLAN_OPTION))
}

/** Answer "allow" once, so Claude Code never writes an always-allow rule into the user's settings. */
function claudeOptions(options: PermissionOption[]): PermissionOption[] {
  if (!options.some((option) => option.kind === 'allow_once')) return options
  return options.filter((option) => option.kind !== 'allow_always')
}

type TurnWait = {
  done: boolean
  waiters: Array<() => void>
  /** A turn we stopped waiting for still owes its turn_completed. That late one must not end the next turn. */
  owed: number
  /** Called once nothing is owed. */
  owedWaiters: Array<() => void>
}

const turnWaits = new Map<string, TurnWait>()

function turnWait(sessionId: string): TurnWait {
  const state = turnWaits.get(sessionId) ?? { done: false, waiters: [], owed: 0, owedWaiters: [] }
  turnWaits.set(sessionId, state)
  return state
}

function beginTurn(sessionId: string): void {
  turnWait(sessionId).done = false
}

function markTurnDone(sessionId: string): void {
  const state = turnWait(sessionId)
  state.done = true
  const waiters = state.waiters.splice(0)
  for (const waiter of waiters) waiter()
}

/** A turn_completed from the agent. One owed by an earlier turn is used up instead. */
function noteTurnCompleted(sessionId: string): void {
  const state = turnWait(sessionId)
  if (state.owed > 0 && !state.done) {
    state.owed -= 1
    if (state.owed === 0) for (const waiter of state.owedWaiters.splice(0)) waiter()
    return
  }
  markTurnDone(sessionId)
}

/**
 * Waits, up to `timeoutMs`, for an earlier turn still streaming on the session to finish. Its last
 * words carry no turn id, so a prompt sent before then would take them as its own.
 */
export function previousTurnEnded(sessionId: string, timeoutMs = 2_000): Promise<void> {
  const state = turnWaits.get(sessionId)
  if (!state || state.owed === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      state.owedWaiters = state.owedWaiters.filter((waiter) => waiter !== finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    state.owedWaiters.push(finish)
  })
}

function waitForTurnEnd(sessionId: string, timeoutMs = 500): Promise<void> {
  const state = turnWait(sessionId)
  if (state.done) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      state.waiters = state.waiters.filter((waiter) => waiter !== finish)
      resolve()
    }
    const timer = setTimeout(() => {
      // At most one is owed: an agent that skips turn_completed must not swallow every later one.
      if (!state.done) state.owed = 1
      finish()
    }, timeoutMs)
    state.waiters.push(finish)
  })
}

function enqueue(conn: Conn, message: JsonRpc): void {
  // Batch a stdout burst so agent_message_chunk is applied before session/prompt resolves.
  conn.inbound.push(message)
  if (conn.flushScheduled) return
  conn.flushScheduled = true
  setImmediate(() => flushInbound(conn))
}

function flushInbound(conn: Conn): void {
  conn.flushScheduled = false
  const batch = conn.inbound.splice(0)
  for (const message of batch) handleMessage(conn, message)
  if (conn.inbound.length > 0) {
    conn.flushScheduled = true
    setImmediate(() => flushInbound(conn))
  }
}

function send(conn: Conn, payload: object): void {
  if (!conn.proc?.stdin.writable) {
    throw new Error(conn.agent === 'claude' ? 'Claude Code is not running' : 'Grok Build is not running')
  }
  conn.proc.stdin.write(`${JSON.stringify(payload)}\n`)
}

/** An answer to the agent. If the agent has gone there is nobody left to answer. */
function trySend(conn: Conn, payload: object): void {
  try {
    send(conn, payload)
  } catch {
    // the process exited while the user was deciding
  }
}

function request<T>(conn: Conn, method: string, params: unknown, timeoutMs: number): Promise<T> {
  const id = conn.nextId++
  return new Promise<T>((resolve, reject) => {
    // timeoutMs <= 0 waits until the agent answers or the process exits.
    // A deadline that fires first deletes the waiter while the turn is still
    // running, so the next message has nothing to attach to.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            conn.pending.delete(id)
            reject(new Error(`${method} timed out`))
          }, timeoutMs)
        : null
    const record = params && typeof params === 'object' ? (params as { sessionId?: unknown }) : null
    conn.pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
      method,
      sessionId: typeof record?.sessionId === 'string' ? record.sessionId : undefined
    })
    try {
      send(conn, { jsonrpc: '2.0', id, method, params })
    } catch (error) {
      if (timer) clearTimeout(timer)
      conn.pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function settlePermission(conn: Conn, message: JsonRpc): Promise<void> {
  const params = (message.params ?? {}) as PermissionParams
  const sessionId = params.sessionId || fallbackSessionId()
  if (conn.agent === 'claude') {
    if (isClaudeExitPlan(params.options ?? [])) {
      await settleClaudeExitPlan(conn, message, params, sessionId)
      return
    }
    params.options = claudeOptions(params.options ?? [])
  }
  const options = params.options ?? []
  // A tool asked for after the user pressed Stop does not run.
  if (sessionId && isSessionStopped(sessionId)) {
    if (message.id !== undefined) {
      trySend(conn, { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })
    }
    return
  }
  const mode = modeForSession(sessionId)
  let decision = decidePermission(mode, params)
  // A bot runs the tools on its list unattended. Anything else asks, and the question sends a notification.
  if (decision === 'ask' && (await botAllowsTool(sessionId, params))) decision = 'allow'
  const requestId = message.id === undefined ? null : promptRequestId(conn, message.id)
  // An edit to files another chat in the same folder changed and has not committed asks first, in any mode.
  const clash = decision !== 'deny' && requestId ? await findClash(sessionId, params) : null
  if (clash) decision = 'ask'

  if (decision === 'deny') noteDeniedPermission(sessionId, params)
  const result =
    decision === 'ask' && requestId
      ? await askPermission(requestId, sessionId, params, clash)
      : outcomeFor(options, decision === 'deny' ? 'deny' : 'allow')

  if (message.id === undefined) return
  // Save the files a tool is about to change before it is let through, so a rewind restores them.
  if ('optionId' in result.outcome && !isRejectOption(options, result.outcome.optionId)) {
    const chatId = chatIdForSession(sessionId)
    if (chatId && params.toolCall) {
      await snapshotBeforeTool(chatId, { sessionUpdate: 'tool_call', ...params.toolCall }).catch(() => {})
    }
  }
  trySend(conn, { jsonrpc: '2.0', id: message.id, result })
}

function isRejectOption(options: PermissionOption[], optionId: string): boolean {
  const kind = (options.find((option) => option.optionId === optionId)?.kind ?? '').toLowerCase()
  return kind.startsWith('reject') || kind.startsWith('deny')
}

/** Show Claude Code's plan in the Workbench plan card and answer with the user's verdict. */
async function settleClaudeExitPlan(
  conn: Conn,
  message: JsonRpc,
  params: PermissionParams,
  sessionId: string
): Promise<void> {
  if (message.id === undefined) return
  const input = params.toolCall?.rawInput
  const plan = input && typeof input === 'object' ? (input as { plan?: unknown }).plan : undefined
  const outcome = await awaitExitPlanVerdict(conn, message.id, sessionId, stringField(plan))
  const options = params.options ?? []
  // Approval returns Claude to its default mode. The Workbench mode then decides each tool.
  const option =
    outcome === 'approved'
      ? (options.find((item) => item.optionId === CLAUDE_EXIT_PLAN_APPROVE) ?? pickOption(options, 'allow'))
      : pickOption(options, 'deny')
  trySend(conn, {
    jsonrpc: '2.0',
    id: message.id,
    result: option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  })
}

function sessionIdFrom(params: unknown): string {
  const record = params && typeof params === 'object' && !Array.isArray(params) ? (params as { sessionId?: unknown }) : null
  return typeof record?.sessionId === 'string' && record.sessionId ? record.sessionId : fallbackSessionId()
}

function stringField(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function rememberModes(sessionId: string, result: unknown): void {
  if (!sessionId) return
  const rec = (result ?? {}) as {
    modes?: { currentModeId?: string; availableModes?: SessionMode[] }
  }
  const available = rec.modes?.availableModes
  if (!available?.length) return
  acpSessionModes.set(sessionId, {
    current: rec.modes?.currentModeId ?? '',
    available
  })
}

export function acpModeIdFor(sessionId: string, want: 'plan' | 'default'): string | null {
  const available = acpSessionModes.get(sessionId)?.available ?? []
  if (available.length === 0) return null
  if (want === 'plan') {
    return available.find((mode) => /plan|architect/i.test(`${mode.id} ${mode.name}`))?.id ?? null
  }
  const rest = available.filter((mode) => !/plan|architect/i.test(`${mode.id} ${mode.name}`))
  for (const id of ['default', 'agent', 'code', 'ask', 'normal']) {
    const hit = rest.find((mode) => mode.id.toLowerCase() === id)
    if (hit) return hit.id
  }
  return rest[0]?.id ?? null
}

export function onExitPlanPrompt(
  listener: (input: { chatId: string; sessionId: string; markdown: string }) => void
): () => void {
  EXIT_PLAN_LISTENERS.add(listener)
  return () => {
    EXIT_PLAN_LISTENERS.delete(listener)
  }
}

function pendingChatId(item: PendingExit): string | null {
  return item.chatId || chatIdForSession(item.sessionId)
}

export function hasPendingExitPlan(chatId: string): boolean {
  for (const item of pendingExits.values()) {
    if (pendingChatId(item) === chatId) return true
  }
  return false
}

export function queueExitPlanVerdict(chatId: string, outcome: ExitPlanOutcome): void {
  queuedVerdicts.set(chatId, { outcome, at: Date.now() })
}

export function takeQueuedExitPlanVerdict(chatId: string): ExitPlanOutcome | null {
  const queued = queuedVerdicts.get(chatId)
  if (!queued) return null
  queuedVerdicts.delete(chatId)
  return Date.now() - queued.at <= QUEUED_VERDICT_TTL_MS ? queued.outcome : null
}

/** The turn ended without asking: its early verdict answers nothing. */
export function clearQueuedExitPlanVerdict(chatId: string): void {
  queuedVerdicts.delete(chatId)
}

export function resolveExitPlan(chatId: string, outcome: ExitPlanOutcome): boolean {
  let found = false
  for (const [key, item] of [...pendingExits.entries()]) {
    if (pendingChatId(item) !== chatId) continue
    pendingExits.delete(key)
    queuedVerdicts.delete(chatId)
    item.resolve(outcome)
    found = true
  }
  return found
}

export function bindExitPlanSession(
  sessionId: string,
  chatId: string,
  options: { silent?: boolean } = {}
): void {
  if (!sessionId || !chatId) return
  for (const item of pendingExits.values()) {
    if (item.sessionId !== sessionId) continue
    if (item.chatId && item.chatId !== chatId) continue
    const alreadyBound = item.chatId === chatId
    item.chatId = chatId
    if (options.silent || alreadyBound) continue
    for (const listener of EXIT_PLAN_LISTENERS) {
      listener({ chatId, sessionId, markdown: item.markdown })
    }
  }
}

function exitPlanResult(outcome: ExitPlanOutcome): Record<string, unknown> {
  return {
    outcome,
    comments: [],
    additional_feedback: '',
    additionalFeedback: ''
  }
}

function planMarkdownFromParams(params: ExitPlanParams, sessionId: string): string {
  const nested = typeof params.plan === 'object' && params.plan ? params.plan : null
  const fromParams = stringField(
    params.planContent,
    params.plan_content,
    params.markdown,
    params.content,
    typeof params.plan === 'string' ? params.plan : '',
    nested?.markdown,
    nested?.content
  )
  if (fromParams) return fromParams
  return readGrokPlan(sessionId)?.markdown ?? ''
}

export function isExitPlanMethod(method?: string): boolean {
  return (
    method === 'x.ai/exit_plan_mode' ||
    method === '_x.ai/exit_plan_mode' ||
    method === 'exit_plan_mode'
  )
}

function awaitExitPlanVerdict(
  conn: Conn,
  id: number | string,
  sessionId: string,
  markdown: string
): Promise<ExitPlanOutcome> {
  // Stop already ended the turn: the plan it asks about is gone.
  if (isSessionStopped(sessionId)) return Promise.resolve('abandoned')
  const chatId = chatIdForSession(sessionId) || ''
  const queued = chatId ? takeQueuedExitPlanVerdict(chatId) : null
  if (queued) return Promise.resolve(queued)
  const requestId = promptRequestId(conn, id)
  return new Promise<ExitPlanOutcome>((resolve) => {
    pendingExits.set(requestId, {
      id,
      sessionId,
      chatId,
      markdown,
      resolve: (value) => {
        pendingExits.delete(requestId)
        resolve(value)
      }
    })
    if (chatId) {
      for (const listener of EXIT_PLAN_LISTENERS) listener({ chatId, sessionId, markdown })
    }
  })
}

async function settleExitPlan(conn: Conn, message: JsonRpc): Promise<void> {
  const params = (message.params ?? {}) as ExitPlanParams
  const sessionId = params.sessionId || sessionIdFrom(message.params) || fallbackSessionId()
  if (message.id === undefined) return

  const markdown = planMarkdownFromParams(params, sessionId)
  const outcome = await awaitExitPlanVerdict(conn, message.id, sessionId, markdown)
  trySend(conn, { jsonrpc: '2.0', id: message.id, result: exitPlanResult(outcome) })
}

async function settleUserQuestion(conn: Conn, message: JsonRpc, kind: 'ext' | 'elicitation'): Promise<void> {
  if (message.id === undefined) return
  const parsed = parseAsk(message.params)
  const sessionId = sessionIdFrom(message.params)
  if (!parsed || isSessionStopped(sessionId)) {
    const skipped = skipOutcome()
    trySend(conn, {
      jsonrpc: '2.0',
      id: message.id,
      result: kind === 'elicitation' ? elicitationResult(skipped, parsed?.fields ?? []) : skipped
    })
    return
  }
  const outcome = await askUserQuestions(promptRequestId(conn, message.id), sessionId, parsed.questions, kind)
  const result = kind === 'elicitation' ? elicitationResult(outcome, parsed.fields) : outcome
  trySend(conn, { jsonrpc: '2.0', id: message.id, result })
}

function handleIncomingRequest(conn: Conn, message: JsonRpc): boolean {
  if (message.method && SESSION_UPDATE_METHODS.has(message.method)) {
    const params = message.params as SessionUpdate | undefined
    if (params?.sessionId) {
      noteToolCallName(params.update)
      if (params.update?.sessionUpdate === 'turn_completed') {
        noteTurnCompleted(params.sessionId)
      }
      const modeId = params.update?.currentModeId || params.update?.modeId
      if (params.update?.sessionUpdate === 'current_mode_update' && modeId) {
        const current = acpSessionModes.get(params.sessionId)
        if (current) acpSessionModes.set(params.sessionId, { ...current, current: modeId })
      }
      if (params.update?.sessionUpdate === 'available_commands_update') {
        acpSessionCommands.set(params.sessionId, readCommands(params.update.availableCommands))
      }
      for (const listener of UPDATE_LISTENERS) listener(params)
    }
    return true
  }

  // Claude Code's notice that a background agent ended, asked for in `sessionRules`.
  if (message.method === '_claude/sdkMessage') {
    const params = message.params as { sessionId?: string; message?: { subtype?: string } } | undefined
    if (params?.sessionId && params.message?.subtype === 'task_notification') {
      for (const listener of TASK_LISTENERS) listener(params.sessionId, params.message)
    }
    return true
  }

  if (message.method === 'session/request_permission') {
    void settlePermission(conn, message).catch(() => {})
    return true
  }

  if (isExitPlanMethod(message.method)) {
    void settleExitPlan(conn, message).catch(() => {})
    return true
  }

  if (isElicitationMethod(message.method)) {
    void settleUserQuestion(conn, message, 'elicitation').catch(() => {})
    return true
  }

  if (
    isUserQuestionMethod(message.method) ||
    (Boolean(message.method) && message.id !== undefined && looksLikeUserQuestion(message.params))
  ) {
    void settleUserQuestion(conn, message, 'ext').catch(() => {})
    return true
  }

  return false
}

function handleMessage(conn: Conn, message: JsonRpc): void {
  if (handleIncomingRequest(conn, message)) return

  if (message.id === undefined || typeof message.id !== 'number') {
    if (message.method && message.id !== undefined) {
      trySend(conn, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` }
      })
    }
    return
  }
  const waiter = conn.pending.get(message.id)
  if (!waiter) {
    if (message.method) {
      trySend(conn, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` }
      })
    }
    return
  }
  if (waiter.timer) clearTimeout(waiter.timer)
  conn.pending.delete(message.id)
  if (message.error) {
    waiter.reject(new Error(message.error.message || JSON.stringify(message.error)))
    return
  }
  waiter.resolve(message.result)
}

type Call = <T>(method: string, params: unknown, timeoutMs: number) => Promise<T>

function connCall(conn: Conn): Call {
  return <T>(method: string, params: unknown, timeoutMs: number) => request<T>(conn, method, params, timeoutMs)
}

async function handshake(agent: ChatAgent, call: Call, clientName: string): Promise<void> {
  const init = await call<{
    authMethods?: Array<{ id: string }>
    agentCapabilities?: { loadSession?: boolean }
  }>(
    'initialize',
    {
      protocolVersion: 1,
      clientInfo: { name: clientName, version: '0.1.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} }
      }
    },
    30_000
  )

  // Claude Code signs in from the user's `claude auth login`. Its adapter has no authenticate step.
  if (agent === 'claude') return

  const methods = new Set((init.authMethods ?? []).map((method) => method.id))
  const apiKey = await getApiKey()
  const methodId = methods.has('cached_token')
    ? 'cached_token'
    : apiKey && methods.has('xai.api_key')
      ? 'xai.api_key'
      : null

  if (!methodId) {
    throw new Error('Run `grok login` once. Datapad Workbench uses your Grok Build session.')
  }

  await call('authenticate', { methodId, _meta: { headless: true } }, 30_000)
}

/** Drop everything waiting on one agent's sessions. The other agent keeps running. */
function releaseAgentState(conn: Conn, reason: string): void {
  const sessions = new Set(conn.liveSessions)
  for (const sessionId of sessionAgents.keys()) {
    if (connForSession(sessionId) === conn) sessions.add(sessionId)
  }
  for (const waiter of conn.pending.values()) {
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.reject(new Error(reason))
  }
  conn.pending.clear()
  conn.liveSessions.clear()
  if (conn.agent === 'claude') resetClaudeOptions()
  conn.inbound.length = 0
  conn.flushScheduled = false
  for (const sessionId of sessions) {
    const turn = turnWaits.get(sessionId)
    if (!turn) continue
    const waiters = turn.waiters.splice(0)
    turn.done = true
    for (const waiter of waiters) waiter()
    turnWaits.delete(sessionId)
  }
  for (const item of [...pendingExits.values()]) {
    if (connForSession(item.sessionId) === conn) item.resolve('abandoned')
  }
  const othersRunning = [...conns.values()].some((other) => other !== conn && other.proc)
  if (!othersRunning) {
    cancelAllPermissions()
    // Project intake asks its questions without an agent. They outlive a crash.
    cancelAgentQuestions()
  } else {
    for (const sessionId of sessions) {
      cancelSessionPermissions(sessionId)
      cancelSessionQuestions(sessionId)
    }
  }
  // These sessions are gone with the process. A new process starts its own.
  for (const sessionId of sessions) {
    acpSessionModes.delete(sessionId)
    acpSessionCommands.delete(sessionId)
    if (connForSession(sessionId) === conn) {
      sessionAgents.delete(sessionId)
      sessionConns.delete(sessionId)
      sessionChatIds.delete(sessionId)
    }
  }
}

function attachProcess(conn: Conn, child: ChildProcessWithoutNullStreams): void {
  conn.proc = child
  conn.generation += 1
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    // Lines still buffered from a process we already replaced belong to nobody.
    if (conn.proc !== child) return
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    try {
      enqueue(conn, JSON.parse(trimmed) as JsonRpc)
    } catch {
      // ignore non-JSON banners
    }
  })
  child.stderr.on('data', () => {
    // keep stderr from filling the pipe
  })
  const gone = (reason: string): void => {
    // An aborted process already released its state, and a new one may be running.
    if (conn.proc !== child) return
    conn.proc = null
    conn.ready = null
    releaseAgentState(conn, reason)
  }
  child.on('exit', () => gone(conn.agent === 'claude' ? 'Claude Code exited' : 'Grok Build exited'))
  // A binary that cannot start emits only 'error'. Without this the app would crash and nothing would release.
  child.on('error', (error) => {
    gone(`${conn.agent === 'claude' ? 'Claude Code' : 'Grok Build'} failed to start: ${error.message}`)
  })
}

function readCommands(list: SessionUpdate['update']['availableCommands']): AgentCommand[] {
  const commands: AgentCommand[] = []
  for (const item of list ?? []) {
    const name = typeof item?.name === 'string' ? item.name.replace(/^\//, '').trim() : ''
    if (!name) continue
    const hint = typeof item.input?.hint === 'string' ? item.input.hint : undefined
    commands.push({ name, description: typeof item.description === 'string' ? item.description : '', hint })
  }
  return commands
}

/** The slash commands an agent announced for a session, if it has. */
export function sessionCommands(sessionId: string): AgentCommand[] {
  return acpSessionCommands.get(sessionId) ?? []
}

export function onSessionUpdate(listener: (update: SessionUpdate) => void): () => void {
  UPDATE_LISTENERS.add(listener)
  return () => {
    UPDATE_LISTENERS.delete(listener)
  }
}

export function onTaskNotification(listener: (sessionId: string, message: unknown) => void): () => void {
  TASK_LISTENERS.add(listener)
  return () => {
    TASK_LISTENERS.delete(listener)
  }
}

export async function ensureAgent(agent: ChatAgent = 'grok', pluginDir?: string | null): Promise<void> {
  const conn = connFor(agent, pluginDir)
  if (conn.ready) return conn.ready
  let child: ChildProcessWithoutNullStreams | null = null
  const ready = (async () => {
    child = await spawnAgent(agent, conn.pluginDir)
    attachProcess(conn, child)
    await handshake(
      agent,
      (method, params, timeoutMs) => request(conn, method, params, timeoutMs),
      'Datapad Workbench'
    )
  })()
  conn.ready = ready
  try {
    await ready
  } catch (error) {
    // Only clean up our own attempt. A later start may already own the connection.
    const mine = child as ChildProcessWithoutNullStreams | null
    if (conn.ready === ready) conn.ready = null
    if (mine && conn.proc === mine) {
      conn.proc = null
      releaseAgentState(conn, error instanceof Error ? error.message : String(error))
    }
    mine?.kill()
    throw error
  }
}

/** Session rules: Grok reads `_meta.rules`, Claude Code appends a system prompt. */
function sessionRules(agent: ChatAgent, rules: string): Record<string, unknown> {
  if (agent === 'claude') {
    return {
      systemPrompt: { mode: 'append', content: [{ type: 'text', text: rules }] },
      // Without this nothing says when a background agent ends.
      _meta: { claudeCode: { emitRawSDKMessages: [{ type: 'system', subtype: 'task_notification' }] } }
    }
  }
  return { _meta: { rules } }
}

async function sessionConfig(
  agent: ChatAgent,
  cwd: string,
  extraRules?: string | null,
  chatId?: string,
  pluginDir?: string | null
): Promise<Record<string, unknown>> {
  const rules = extraRules?.trim()
    ? `${BROWSER_SESSION_RULE}\n\n${extraRules.trim()}`
    : BROWSER_SESSION_RULE
  const config = { cwd, mcpServers: [...(await browserMcpServers(chatId)), ...toAcpMcpServers(await getMcpServers())] }
  if (agent !== 'claude') return { ...config, ...sessionRules(agent, rules) }
  // A bot's own skills come with the session, as a plugin in the bot's folder.
  const plugins = pluginDir ? { plugins: [{ type: 'local', path: pluginDir }] } : {}
  if (!chatId) {
    const session = sessionRules(agent, rules)
    if (!pluginDir) return { ...config, ...session }
    const meta = (session._meta as { claudeCode: Record<string, unknown> }).claudeCode
    return { ...config, ...session, _meta: { claudeCode: { ...meta, options: plugins } } }
  }
  // Claude Code starts agents of its own with its Agent tool. Settings holds for those too.
  const subagentModel = await getSubagentModel()
  const session = sessionRules(agent, `${rules}\n\n${agentToolRule(subagentModel, await getMaxSubagents())}`)
  const meta = (session._meta as { claudeCode: Record<string, unknown> }).claudeCode
  return {
    ...config,
    ...session,
    _meta: {
      claudeCode: {
        ...meta,
        options: {
          settings: await agentHookSettings(chatId),
          ...(subagentModel ? { env: { CLAUDE_CODE_SUBAGENT_MODEL: subagentModel } } : {}),
          ...plugins
        }
      }
    }
  }
}

async function applySessionEffort(sessionId: string, effort: ReasoningEffort | null): Promise<void> {
  const conn = connForSession(sessionId)
  if (!effort || !conn.proc || !conn.liveSessions.has(sessionId)) return
  try {
    await request(
      conn,
      'session/set_config_option',
      conn.agent === 'claude'
        ? { sessionId, configId: 'effort', value: effort }
        : // Grok Build tops out at Extra high, so Claude's Max maps to it.
          { sessionId, configId: 'reasoning_effort', value: { value: effort === 'max' ? 'xhigh' : effort } },
      8_000
    )
  } catch {
    // The active model may not advertise reasoning effort. The session still runs.
  }
}

export async function applyEffortToLiveSessions(effort: ReasoningEffort | null): Promise<void> {
  if (!effort) return
  const sessions = [...conns.values()].flatMap((conn) => (conn.proc ? [...conn.liveSessions] : []))
  await Promise.all(
    sessions.map(async (sessionId) => {
      // A bot with an effort of its own keeps it.
      const bot = await chatBot(sessionChatIds.get(sessionId)).catch(() => null)
      await applySessionEffort(sessionId, bot?.effort || effort)
    })
  )
}

/** Pick the session's model. Claude Code takes an alias or a model id, Grok Build a model id. */
async function applyClaudeModel(call: Call, sessionId: string, model: string): Promise<void> {
  if (!model) return
  try {
    await call('session/set_config_option', { sessionId, configId: 'model', value: model }, 8_000)
  } catch {
    // An alias this plan does not offer. Claude Code keeps its default.
  }
}

type ConfigOption = {
  id?: string
  options?: Array<{ value?: unknown; name?: unknown; description?: unknown }>
}

function readClaudeOptions(configOptions: unknown): ClaudeOptions | null {
  if (!Array.isArray(configOptions)) return null
  const list = configOptions as ConfigOption[]
  const models = list.find((option) => option.id === 'model')?.options
  if (!models?.length) return null
  const efforts = list.find((option) => option.id === 'effort')?.options ?? []
  return {
    // The settings store the default as an empty string. Its description names the model.
    models: models.flatMap((option) => {
      if (typeof option.value !== 'string') return []
      const description = typeof option.description === 'string' ? option.description : undefined
      const name = typeof option.name === 'string' ? option.name : option.value
      return option.value === 'default'
        ? [{ value: '', name: description ? `Default (${description})` : 'Default' }]
        : [{ value: option.value, name, description }]
    }),
    efforts: efforts.flatMap((option) => {
      const effort = normalizeReasoningEffort(option.value)
      return effort ? [effort] : []
    })
  }
}

// A session that never gets a prompt, kept only to read what Claude Code offers.
// Without a prompt it writes no transcript, so it never shows up as a chat.
let claudeProbe: Promise<string> | null = null
let claudeProbeQueue: Promise<unknown> = Promise.resolve()
const claudeOptionsCache = new Map<string, ClaudeOptions>()

function resetClaudeOptions(): void {
  claudeProbe = null
  claudeOptionsCache.clear()
}

/** Claude Code's model list, and the effort levels of `model` ('' is the default). */
export function getClaudeOptions(model: string): Promise<ClaudeOptions | null> {
  const key = model || 'default'
  const cached = claudeOptionsCache.get(key)
  if (cached) return Promise.resolve(cached)
  const next = claudeProbeQueue.then(async () => {
    const hit = claudeOptionsCache.get(key)
    if (hit) return hit
    let sessionId: string
    try {
      await ensureAgent('claude')
      if (!claudeProbe) {
        claudeProbe = request<{ sessionId: string; configOptions?: unknown }>(
          claudeConn,
          'session/new',
          { cwd: tmpdir(), mcpServers: [] },
          30_000
        ).then((result) => {
          sessionAgents.set(result.sessionId, 'claude')
          const options = readClaudeOptions(result.configOptions)
          if (options) claudeOptionsCache.set('default', options)
          return result.sessionId
        })
      }
      sessionId = await claudeProbe
    } catch {
      // Only a failed probe is retried next time. The models already read stay known.
      claudeProbe = null
      return claudeOptionsCache.get(key) ?? null
    }
    if (claudeOptionsCache.has(key)) return claudeOptionsCache.get(key) ?? null
    try {
      const result = await request<{ configOptions?: unknown }>(
        claudeConn,
        'session/set_config_option',
        { sessionId, configId: 'model', value: key },
        8_000
      )
      const options = readClaudeOptions(result.configOptions)
      if (options) claudeOptionsCache.set(key, options)
    } catch {
      // One model Claude Code will not switch to says nothing about the others.
    }
    return claudeOptionsCache.get(key) ?? null
  })
  claudeProbeQueue = next
  return next
}

/** Put every live Claude chat on its model again, after a setting or a chat's role changed. */
export async function applyClaudeModelToLiveSessions(): Promise<void> {
  const conn = claudeConn
  if (!conn.proc) return
  const call = connCall(conn)
  await Promise.all(
    [...conn.liveSessions].map(async (sessionId) => {
      // Back to "default" when the setting is cleared, so live chats follow it too.
      const model = await claudeModelFor(sessionChatIds.get(sessionId)).catch(() => '')
      await applyClaudeModel(call, sessionId, model || 'default')
    })
  )
}

async function applySessionSettings(agent: ChatAgent, sessionId: string, chatId?: string): Promise<void> {
  if (chatId) sessionChatIds.set(sessionId, chatId)
  // A bot's chats run at the bot's effort, and a Grok bot on its own model. Other Grok chats keep Grok's default.
  const bot = await chatBot(chatId).catch(() => null)
  if (agent !== 'claude' && bot?.agent === 'grok') {
    await applyClaudeModel(connCall(connForSession(sessionId)), sessionId, bot.model)
  }
  await applySessionEffort(sessionId, bot?.effort || (await getEffort()))
  if (agent !== 'claude') return
  await applyClaudeModel(connCall(claudeConn), sessionId, await claudeModelFor(chatId))
}

/** Put the live chats of a bot on its model and effort again, after its page was saved. */
export async function applyBotToLiveSessions(botId: string): Promise<void> {
  const sessions = [...conns.values()].flatMap((conn) =>
    conn.proc ? [...conn.liveSessions].map((sessionId) => ({ agent: conn.agent, sessionId })) : []
  )
  await Promise.all(
    sessions.map(async ({ agent, sessionId }) => {
      const chatId = sessionChatIds.get(sessionId)
      const bot = await chatBot(chatId).catch(() => null)
      if (bot?.id === botId) await applySessionSettings(agent, sessionId, chatId)
    })
  )
}

/** `pluginDir` is a bot's folder: the session loads the bot's own skills from it. */
export async function newSession(
  cwd: string,
  extraRules?: string | null,
  agent: ChatAgent = 'grok',
  chatId?: string,
  pluginDir?: string | null
): Promise<string> {
  await ensureAgent(agent, pluginDir)
  const conn = connFor(agent, pluginDir)
  const result = await request<{
    sessionId: string
    modes?: { currentModeId?: string; availableModes?: SessionMode[] }
  }>(conn, 'session/new', await sessionConfig(agent, cwd, extraRules, chatId, pluginDir), 30_000)
  bindSession(result.sessionId, conn)
  rememberModes(result.sessionId, result)
  conn.liveSessions.add(result.sessionId)
  await applySessionSettings(agent, result.sessionId, chatId)
  return result.sessionId
}

export async function loadSession(
  sessionId: string,
  cwd: string,
  extraRules?: string | null,
  agent: ChatAgent = 'grok',
  chatId?: string,
  pluginDir?: string | null
): Promise<void> {
  await ensureAgent(agent, pluginDir)
  const conn = connFor(agent, pluginDir)
  bindSession(sessionId, conn)
  const result = await request<unknown>(
    conn,
    'session/load',
    { sessionId, ...(await sessionConfig(agent, cwd, extraRules, chatId, pluginDir)) },
    60_000
  )
  rememberModes(sessionId, result)
  conn.liveSessions.add(sessionId)
  await applySessionSettings(agent, sessionId, chatId)
}

export function hasLiveSession(sessionId: string): boolean {
  const conn = connForSession(sessionId)
  return conn.proc !== null && conn.liveSessions.has(sessionId)
}

function moneyVal(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && 'val' in value) {
    const inner = (value as { val?: unknown }).val
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner
  }
  return null
}

function textVal(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function periodKind(value: unknown): UsagePeriodKind {
  const raw = typeof value === 'string' ? value.toUpperCase() : ''
  if (raw.includes('WEEKLY')) return 'weekly'
  if (raw.includes('MONTHLY')) return 'monthly'
  return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Grok lists its slash commands when asked instead of announcing them.
 * A live session adds the project's own skills; without one the list is the user's.
 */
export async function grokCommands(sessionId: string | null): Promise<AgentCommand[]> {
  const live = sessionId && hasLiveSession(sessionId) ? sessionId : null
  const key = live ?? ''
  const known = acpSessionCommands.get(key)
  if (known?.length) return known
  const conn = live ? connForSession(live) : grokConn
  await ensureAgent('grok', conn.pluginDir)
  const raw = asRecord(await request<unknown>(conn, '_x.ai/commands/list', live ? { sessionId: live } : {}, 10_000))
  const commands = readCommands(raw.commands as SessionUpdate['update']['availableCommands'])
  acpSessionCommands.set(key, commands)
  return commands
}

export async function fetchUsage(): Promise<UsageSnapshot> {
  await ensureAgent('grok')
  const raw = asRecord(await request<unknown>(grokConn, '_x.ai/billing', {}, 20_000))
  const config = asRecord(raw.config ?? raw)
  const period = asRecord(config.currentPeriod)
  const used = moneyVal(config.creditUsagePercent)
  return {
    tier: textVal(raw.subscription_tier) ?? textVal(raw.subscriptionTier),
    usedPercent: used === null ? null : Math.min(100, Math.max(0, used)),
    period: periodKind(period.type ?? config.billingCycle),
    periodStart: textVal(period.start) ?? textVal(config.billingPeriodStart),
    periodEnd: textVal(period.end) ?? textVal(config.billingPeriodEnd),
    prepaidBalance: moneyVal(config.prepaidBalance),
    onDemandCap: moneyVal(config.onDemandCap),
    onDemandUsed: moneyVal(config.onDemandUsed),
    unifiedBilling: config.isUnifiedBillingUser === true
  }
}

export async function setAcpSessionMode(sessionId: string, modeId: string): Promise<boolean> {
  if (!sessionId || !modeId) return false
  const conn = connForSession(sessionId)
  // A fresh process does not know this session. The mode is applied when the chat next loads it.
  if (!conn.proc || !conn.liveSessions.has(sessionId)) return false
  try {
    await request(conn, 'session/set_mode', { sessionId, modeId }, 15_000)
    const current = acpSessionModes.get(sessionId)
    if (current) acpSessionModes.set(sessionId, { ...current, current: modeId })
    return true
  } catch {
    return false
  }
}

export async function promptSession(
  sessionId: string,
  text: string,
  images: Array<{ mimeType: string; data: string }> = []
): Promise<void> {
  const conn = connForSession(sessionId)
  await ensureAgent(conn.agent, conn.pluginDir)
  const prompt: Array<{ type: string; text?: string; mimeType?: string; data?: string }> = []
  if (text.trim()) {
    prompt.push({ type: 'text', text })
  }
  for (const image of images) {
    prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data })
  }
  if (prompt.length === 0) {
    throw new Error('Message is empty')
  }
  beginTurn(sessionId)
  await request(
    conn,
    'session/prompt',
    {
      sessionId,
      prompt
    },
    0
  )
  // Grok can send turn_completed after the prompt reply. Claude Code sends every update first.
  if (conn.agent === 'grok') await waitForTurnEnd(sessionId)
  else markTurnDone(sessionId)
}

export function cancelSession(sessionId: string): void {
  const conn = connForSession(sessionId)
  if (!conn.proc) return
  trySend(conn, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
}

/** Which process an agent is on. A kill aimed at one process must not hit its replacement. */
export function agentGeneration(key: AgentKey): number {
  return conns.get(key)?.generation ?? 0
}

/**
 * Whether the process is still answering anything not of this session: another chat's prompt, or a
 * session it is opening or loading (a new session has no id yet).
 */
export function hasOtherActivePrompts(sessionId: string): boolean {
  const conn = connForSession(sessionId)
  for (const waiter of conn.pending.values()) {
    if (waiter.sessionId !== sessionId) return true
  }
  return false
}

/** Kill every agent process, for quitting. */
export function stopAgents(): void {
  for (const key of conns.keys()) abortAgent(key)
}

/** Kill one agent process. Chats on the others keep running. */
export function abortAgent(key: AgentKey = 'grok', generation?: number): void {
  const conn = conns.get(key)
  if (!conn) return
  const child = conn.proc
  if (!child) return
  if (generation !== undefined && generation !== conn.generation) return
  conn.proc = null
  conn.ready = null
  try {
    child.kill()
  } catch {
    // already gone
  }
  releaseAgentState(conn, 'cancelled')
}

export async function promptIsolated(
  cwd: string,
  text: string,
  images: Array<{ mimeType: string; data: string }> = [],
  onText?: (chunk: string) => void,
  signal?: AbortSignal,
  options?: { timeoutMs?: number; rules?: string; agent?: ChatAgent }
): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled')
  const agent = options?.agent ?? 'grok'
  const child = await spawnAgent(agent)
  if (signal?.aborted) {
    child.kill()
    throw new Error('cancelled')
  }
  let next = 1
  const waiters = new Map<number, Pending>()
  let assembled = ''

  const write = (payload: object): void => {
    if (!child.stdin.writable) throw new Error('Aside agent is not running')
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
  // Answers from the line handler: a throw there would be uncaught.
  const answer = (payload: object): void => {
    try {
      write(payload)
    } catch {
      // the aside already stopped
    }
  }

  const call = <T,>(method: string, params: unknown, timeoutMs: number): Promise<T> => {
    const id = next++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              waiters.delete(id)
              reject(new Error(`${method} timed out`))
            }, timeoutMs)
          : null
      waiters.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      write({ jsonrpc: '2.0', id, method, params })
    })
  }

  const onLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let message: JsonRpc
    try {
      message = JSON.parse(trimmed) as JsonRpc
    } catch {
      return
    }
    if (message.method === 'session/update') {
      const params = message.params as SessionUpdate | undefined
      if (params?.update?.sessionUpdate === 'agent_message_chunk') {
        const chunk = contentText(params.update.content)
        if (chunk) {
          assembled += chunk
          onText?.(chunk)
        }
      }
      return
    }
    if (message.method === 'session/request_permission') {
      const params = (message.params ?? {}) as PermissionParams
      const tool = params.toolCall
      const options = params.options ?? []
      const deny =
        (agent === 'claude' && isClaudeExitPlan(options)) ||
        isPlanGateTool(params) ||
        isMutatingTool(tool?.kind, tool?.title, tool?.name)
      if (message.id !== undefined) {
        answer({
          jsonrpc: '2.0',
          id: message.id,
          result: outcomeFor(agent === 'claude' ? claudeOptions(options) : options, deny ? 'deny' : 'allow')
        })
      }
      return
    }
    if (isExitPlanMethod(message.method)) {
      if (message.id !== undefined) {
        answer({ jsonrpc: '2.0', id: message.id, result: exitPlanResult('abandoned') })
      }
      return
    }
    if (
      isUserQuestionMethod(message.method) ||
      isElicitationMethod(message.method) ||
      looksLikeUserQuestion(message.params)
    ) {
      if (message.id !== undefined) {
        const skipped = skipOutcome()
        answer({
          jsonrpc: '2.0',
          id: message.id,
          result: isElicitationMethod(message.method)
            ? elicitationResult(skipped, [])
            : skipped
        })
      }
      return
    }
    if (message.id === undefined || typeof message.id !== 'number') return
    const waiter = waiters.get(message.id)
    if (!waiter) return
    if (waiter.timer) clearTimeout(waiter.timer)
    waiters.delete(message.id)
    if (message.error) {
      waiter.reject(new Error(message.error.message || JSON.stringify(message.error)))
      return
    }
    waiter.resolve(message.result)
  }

  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', onLine)
  child.stderr.on('data', () => undefined)
  // A process that dies or never starts answers nothing. Without this the prompt waits forever.
  const fail = (reason: string): void => {
    for (const waiter of waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(new Error(reason))
    }
    waiters.clear()
  }
  child.on('exit', () => fail('Aside agent exited'))
  child.on('error', (error) => fail(`Aside agent failed to start: ${error.message}`))

  const stop = (): void => {
    for (const waiter of waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(new Error('cancelled'))
    }
    waiters.clear()
    rl.close()
    if (!child.killed) child.kill()
  }

  const onAbort = (): void => stop()
  signal?.addEventListener('abort', onAbort)

  try {
    await handshake(agent, call, 'Datapad Workbench-aside')
    const rules =
      options?.rules ??
      'Read-only aside on the current main task. Use the provided context. You may read project files. Do not edit files or run mutating commands.'
    // Grok keeps every session under its folder. This one must not come back as a chat.
    const created = await skipNewSession(call<{ sessionId: string }>(
      'session/new',
      {
        cwd,
        mcpServers: [],
        ...sessionRules(agent, rules),
        // Side questions are throwaway: keep them out of the user's Claude Code history.
        ...(agent === 'claude' ? { _meta: { claudeCode: { options: { persistSession: false } } } } : {})
      },
      30_000
    ))
    if (agent === 'claude') await applyClaudeModel(call, created.sessionId, await getClaudeModel())
    const prompt: Array<{ type: string; text?: string; mimeType?: string; data?: string }> = []
    if (text.trim()) prompt.push({ type: 'text', text })
    for (const image of images) {
      prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data })
    }
    await call('session/prompt', { sessionId: created.sessionId, prompt }, options?.timeoutMs ?? 0)
    return assembled.trim()
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stop()
  }
}

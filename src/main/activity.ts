import { BrowserWindow } from 'electron'
import type {
  ActivityDiff,
  ActivityEvent,
  ActivityFeed,
  ActivitySnapshot,
  ActivityStatus
} from '../shared/types'
import { contentText, onSessionUpdate, type SessionUpdate } from './acp'
import { id, now } from './ids'
import { latestTaskLine } from './taskProgress'

const MAX_EVENTS = 400
/** Late updates still need their chat after the turn ends, so keep the most recently bound sessions. */
const MAX_SESSIONS = 200

type BoundChat = {
  id: string
  title: string
}

let started = false
const events: ActivityEvent[] = []
const sessions = new Map<string, BoundChat>()
const listeners = new Set<(feed: ActivityFeed) => void>()

/** How long a running turn can sit without a new event before we say so. */
const QUIET_MS = 60_000
const quietTimers = new Map<string, ReturnType<typeof setTimeout>>()
const taskPolls = new Map<string, ReturnType<typeof setInterval>>()
const taskSeen = new Map<string, string>()
const turnStartedAt = new Map<string, number>()
const TASK_POLL_MS = 2_000

function heartbeatKey(chatId: string): string {
  return `heartbeat:${chatId}`
}

function clearQuiet(chatId: string): void {
  const timer = quietTimers.get(chatId)
  if (timer) clearTimeout(timer)
  quietTimers.delete(chatId)
}

function stillWorkingLabel(chatId: string): string {
  const elapsed = Date.now() - (turnStartedAt.get(chatId) ?? Date.now())
  const mins = Math.max(1, Math.floor(elapsed / 60_000))
  return mins === 1 ? 'Still working · 1 min in' : `Still working · ${mins} min in`
}

function taskHints(chatId: string): string {
  const bits: string[] = []
  for (let i = events.length - 1; i >= 0 && bits.length < 8; i--) {
    const event = events[i]
    if (event.chatId !== chatId || event.kind !== 'tool') continue
    if (event.coalesceKey?.startsWith('taskfeed:')) continue
    if (event.detail) bits.push(event.detail)
    if (event.title) bits.push(event.title)
  }
  return bits.join('\n')
}

function taskLine(chatId: string, sessionId: string | null): string | null {
  const since = (turnStartedAt.get(chatId) ?? Date.now()) - 2_000
  return latestTaskLine(sessionId, taskHints(chatId), since)
}

function clipLine(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, max - 1).trim()}…`
}

function publishTaskLine(chatId: string, line: string): void {
  const turn = events.find((event) => event.coalesceKey === `turn:${chatId}`)
  if (!turn || turn.status !== 'running') return
  const label = clipLine(line)
  emitActivity({
    kind: 'tool',
    chatId,
    chatTitle: turn.chatTitle,
    sessionId: turn.sessionId,
    title: label,
    detail: line.slice(0, 2_000),
    toolKind: 'progress',
    status: 'running',
    coalesceKey: `taskfeed:${chatId}`
  })
}

function pollTask(chatId: string): void {
  const turn = events.find((event) => event.coalesceKey === `turn:${chatId}`)
  if (!turn || turn.status !== 'running') {
    stopTaskPoll(chatId)
    return
  }
  const line = taskLine(chatId, turn.sessionId)
  if (!line) return
  const seen = taskSeen.get(chatId)
  if (line === seen) return
  taskSeen.set(chatId, line)
  publishTaskLine(chatId, line)
}

function stopTaskPoll(chatId: string): void {
  const timer = taskPolls.get(chatId)
  if (timer) clearInterval(timer)
  taskPolls.delete(chatId)
  taskSeen.delete(chatId)
}

function startTaskPoll(chatId: string): void {
  stopTaskPoll(chatId)
  pollTask(chatId)
  taskPolls.set(
    chatId,
    setInterval(() => pollTask(chatId), TASK_POLL_MS)
  )
}

function pulseQuiet(chatId: string): void {
  quietTimers.delete(chatId)
  const turn = events.find((event) => event.coalesceKey === `turn:${chatId}`)
  if (!turn || turn.status !== 'running') return
  const line = taskLine(chatId, turn.sessionId)
  const label = line ? `${stillWorkingLabel(chatId)} · ${clipLine(line, 100)}` : stillWorkingLabel(chatId)
  emitActivity({
    kind: 'thought',
    chatId,
    chatTitle: turn.chatTitle,
    sessionId: turn.sessionId,
    title: label,
    detail: label,
    status: 'running',
    coalesceKey: heartbeatKey(chatId)
  })
  armQuiet(chatId)
}

function armQuiet(chatId: string): void {
  clearQuiet(chatId)
  quietTimers.set(
    chatId,
    setTimeout(() => pulseQuiet(chatId), QUIET_MS)
  )
}

function noteSignal(chatId: string | null, coalesceKey?: string): void {
  if (!chatId || coalesceKey === heartbeatKey(chatId)) return
  const turn = events.find((event) => event.coalesceKey === `turn:${chatId}`)
  if (!turn || turn.status !== 'running') return
  armQuiet(chatId)
}

export function bindSession(sessionId: string, chat: BoundChat): void {
  // Rebinding moves the session to the back, so the least recently used one goes first.
  sessions.delete(sessionId)
  sessions.set(sessionId, chat)
  for (const oldest of sessions.keys()) {
    if (sessions.size <= MAX_SESSIONS) break
    sessions.delete(oldest)
  }
}

export function lookupSession(sessionId: string): BoundChat | null {
  return sessions.get(sessionId) ?? null
}

export function onActivityFeed(listener: (feed: ActivityFeed) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function broadcast(feed: ActivityFeed): void {
  for (const listener of listeners) listener(feed)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('activity:event', feed)
  }
}

const pendingBroadcasts = new Map<string, ActivityEvent>()
let broadcastTimer: ReturnType<typeof setTimeout> | null = null

function flushBroadcasts(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  if (pendingBroadcasts.size === 0) return
  const batch = [...pendingBroadcasts.values()]
  pendingBroadcasts.clear()
  for (const event of batch) broadcast({ type: 'upsert', event })
}

function publish(event: ActivityEvent): void {
  const batch = (event.kind === 'thought' || event.kind === 'write') && event.status === 'running'
  if (batch) {
    pendingBroadcasts.set(event.id, event)
    if (!broadcastTimer) broadcastTimer = setTimeout(flushBroadcasts, 80)
    return
  }
  flushBroadcasts()
  broadcast({ type: 'upsert', event })
}

function joinText(previous: string | null, next: string | null): string | null {
  if (!previous) return next
  if (!next) return previous
  return previous + next
}

function emitActivity(
  input: Omit<ActivityEvent, 'id' | 'at'> & { id?: string; at?: string }
): ActivityEvent {
  const incoming: ActivityEvent = {
    id: input.id ?? id(),
    at: input.at ?? now(),
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    sessionId: input.sessionId,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    status: input.status,
    toolKind: input.toolKind,
    diffs: input.diffs,
    coalesceKey: input.coalesceKey
  }

  if (incoming.coalesceKey) {
    const index = events.findIndex((event) => event.coalesceKey === incoming.coalesceKey)
    if (index >= 0) {
      const previous = events[index]
      // A finished row stays finished: late chunks can't revive it. A goal row is reused across turns.
      const revived =
        (previous.status === 'done' || previous.status === 'error') &&
        incoming.status === 'running' &&
        !incoming.coalesceKey.startsWith('goal:')
      const merged: ActivityEvent = {
        ...previous,
        ...incoming,
        id: previous.id,
        at:
          incoming.coalesceKey?.startsWith('heartbeat:') || incoming.coalesceKey?.startsWith('taskfeed:')
            ? incoming.at
            : previous.at,
        title: preferTitle(incoming.title, previous.title),
        toolKind: incoming.toolKind || previous.toolKind,
        status: revived ? previous.status : (incoming.status ?? previous.status),
        detail: mergeDetail(previous, incoming),
        diffs:
          incoming.diffs && incoming.diffs.length > 0 ? incoming.diffs : previous.diffs,
        endedAt:
          previous.status === 'running' && incoming.status && incoming.status !== 'running'
            ? now()
            : previous.endedAt
      }
      events[index] = merged
      publish(merged)
      noteSignal(merged.chatId, merged.coalesceKey)
      return merged
    }
  }

  events.push(incoming)
  if (events.length > MAX_EVENTS) events.splice(events.findIndex((event) => !isLiveTurn(event)), 1)
  publish(incoming)
  noteSignal(incoming.chatId, incoming.coalesceKey)
  return incoming
}

/** The heartbeat and task feed hang off a running turn's row, so eviction and clearing keep it. */
function isLiveTurn(event: ActivityEvent): boolean {
  return event.kind === 'turn' && event.status === 'running'
}

function boundFields(sessionId: string | null): Pick<ActivityEvent, 'chatId' | 'chatTitle'> {
  if (!sessionId) return { chatId: null, chatTitle: null }
  const bound = lookupSession(sessionId)
  return { chatId: bound?.id ?? null, chatTitle: bound?.title ?? null }
}

export function emitGoal(input: {
  chatId: string
  chatTitle: string
  sessionId: string | null
  title: string
  detail?: string | null
}): void {
  emitActivity({
    kind: 'goal',
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    sessionId: input.sessionId,
    title: input.title,
    detail: input.detail ?? null,
    status: 'running',
    coalesceKey: `goal:${input.chatId}`
  })
}

export function emitNotice(input: {
  chatId: string
  chatTitle: string
  title: string
  detail: string
}): void {
  emitActivity({
    kind: 'write',
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    sessionId: null,
    title: input.title,
    detail: input.detail,
    status: 'done'
  })
}

export function startTurn(input: {
  chatId: string
  chatTitle: string
  sessionId: string
  prompt: string
}): void {
  bindSession(input.sessionId, { id: input.chatId, title: input.chatTitle })
  turnStartedAt.set(input.chatId, Date.now())
  // A turn that was superseded never finished: close its rows before they lose their keys.
  settleRunning(input.chatId, 'done')
  // Each turn gets its own events: stop the last turn's rows from absorbing this one.
  for (const event of events) {
    if (event.chatId === input.chatId && event.coalesceKey && !event.coalesceKey.startsWith('goal:')) {
      event.coalesceKey = undefined
    }
  }
  emitActivity({
    kind: 'turn',
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    sessionId: input.sessionId,
    title: input.chatTitle,
    detail: input.prompt,
    status: 'running',
    coalesceKey: `turn:${input.chatId}`
  })
  startTaskPoll(input.chatId)
}

export function emitPermissionActivity(input: {
  chatId: string
  sessionId: string | null
  title: string
  detail: string | null
  status: ActivityStatus
  requestId: string
}): void {
  const bound = input.sessionId ? boundFields(input.sessionId) : { chatId: input.chatId, chatTitle: null }
  emitActivity({
    kind: 'permission',
    chatId: input.chatId,
    chatTitle: bound.chatTitle,
    sessionId: input.sessionId,
    title: input.title,
    detail: input.detail,
    status: input.status,
    coalesceKey: `permission:${input.requestId}`
  })
}

export function finishTurn(chatId: string, status: Exclude<ActivityStatus, 'running'>, error?: string): void {
  clearQuiet(chatId)
  stopTaskPoll(chatId)
  turnStartedAt.delete(chatId)
  const current = events.find((event) => event.coalesceKey === `turn:${chatId}`)
  emitActivity({
    kind: 'turn',
    chatId,
    chatTitle: current?.chatTitle ?? null,
    sessionId: current?.sessionId ?? null,
    title: current?.title ?? 'Turn',
    detail: error ?? current?.detail ?? null,
    status,
    coalesceKey: `turn:${chatId}`
  })
  settleRunning(chatId, status)
}

/** Finishes the chat's running rows in place, including rows that no longer have a coalesce key. */
function settleRunning(chatId: string, status: Exclude<ActivityStatus, 'running'>): void {
  for (const [index, event] of events.entries()) {
    if (event.chatId !== chatId || event.status !== 'running') continue
    const settled: ActivityEvent = {
      ...event,
      status: status === 'error' && event.kind !== 'thought' ? 'error' : 'done',
      endedAt: now()
    }
    events[index] = settled
    publish(settled)
  }
}

export function getActivitySnapshot(): ActivitySnapshot {
  return { events: [...events] }
}

/** Clears everything but running turns, whose timers keep going until finishTurn stops them. */
export function clearActivity(): ActivitySnapshot {
  flushBroadcasts()
  const live = events.filter(isLiveTurn)
  events.splice(0, events.length, ...live)
  broadcast({ type: 'reset', events: [...live] })
  return getActivitySnapshot()
}

const WEAK_LABELS = new Set([
  'tool',
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
  'call'
])

const SKIP_KEYS = /^(data|blob|image|token|apikey|api_key|password|secret|authorization|sessionid)$/i
const INPUT_KEYS = [
  'command',
  'cmd',
  'script',
  'code',
  'query',
  'pattern',
  'glob',
  'url',
  'uri',
  'path',
  'file',
  'file_path',
  'target_file',
  'filename',
  'prompt',
  'text',
  'description'
]
const OUTPUT_KEYS = ['stdout', 'stderr', 'output', 'result', 'text', 'content', 'message', 'error']

function clip(text: string, max = 2400): string {
  const lines = text.replace(/\s+$/u, '').split('\n')
  const limited = lines.length > 48 ? `${lines.slice(0, 48).join('\n')}\n… ${lines.length - 48} more lines` : text
  if (limited.length <= max) return limited
  return `${limited.slice(0, max).trimEnd()}…`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function isWeakLabel(value: string | null | undefined): boolean {
  if (!value) return true
  return WEAK_LABELS.has(value.trim().toLowerCase())
}

function preferTitle(incoming: string, previous: string): string {
  if (isWeakLabel(incoming)) return previous || incoming
  return incoming
}

function mergeDetail(previous: ActivityEvent, incoming: ActivityEvent): string | null {
  if (incoming.coalesceKey?.startsWith('heartbeat:') || incoming.coalesceKey?.startsWith('taskfeed:')) {
    return incoming.detail ?? previous.detail
  }
  if (incoming.kind === 'thought' && incoming.id !== previous.id) {
    return joinText(previous.detail, incoming.detail)
  }
  if (incoming.kind !== 'tool') return incoming.detail ?? previous.detail
  const prev = previous.detail
  const next = incoming.detail
  if (!next) return prev
  if (!prev) return next
  if (isWeakLabel(next)) return prev
  if (isWeakLabel(prev)) return next
  if (next.includes(prev)) return next
  if (prev.includes(next)) return prev
  return `${prev}\n\n${next}`
}

function toolStatus(value: string | undefined): ActivityStatus | null {
  const status = (value ?? '').toLowerCase()
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'completed' || status === 'done' || status === 'cancelled') return 'done'
  if (status === 'pending' || status === 'in_progress' || status === 'running') return 'running'
  return value ? 'running' : null
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts.at(-1) || path
}

function prettyObject(value: unknown, depth = 0): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() ? value : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value
      .slice(0, 12)
      .map((item) => prettyObject(item, depth + 1))
      .filter((item): item is string => Boolean(item))
    return parts.length > 0 ? parts.join('\n') : null
  }
  const record = asRecord(value)
  if (!record) return null
  const nested =
    asRecord(record.arguments) ?? asRecord(record.input) ?? asRecord(record.params) ?? asRecord(record.args)
  if (nested && depth < 3) {
    const fromNested = prettyObject(nested, depth + 1)
    if (fromNested) return fromNested
  }
  const lines: string[] = []
  for (const [key, item] of Object.entries(record)) {
    if (SKIP_KEYS.test(key)) continue
    if (item == null) continue
    if (typeof item === 'string') {
      if (!item.trim()) continue
      lines.push(item.includes('\n') ? `${key}:\n${item}` : `${key}: ${item}`)
      continue
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      lines.push(`${key}: ${item}`)
      continue
    }
    const nestedText = prettyObject(item, depth + 1)
    if (nestedText) lines.push(item && typeof item === 'object' ? `${key}:\n${nestedText}` : `${key}: ${nestedText}`)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

function pickPreferred(value: unknown, keys: string[], depth = 0): string | null {
  if (typeof value === 'string') return value.trim() ? value : null
  const record = asRecord(value)
  if (!record || depth > 3) return null
  const hit = firstString(record, keys)
  if (hit) return hit
  for (const nested of [record.arguments, record.input, record.params, record.args]) {
    const found = pickPreferred(nested, keys, depth + 1)
    if (found) return found
  }
  return null
}

function summarizeBlob(value: unknown, preferredKeys: string[]): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() ? value : null
  const preferred = pickPreferred(value, preferredKeys)
  const rest = prettyObject(value)
  if (preferred && rest && rest !== preferred && !rest.includes(preferred)) return `${preferred}\n${rest}`
  return preferred ?? rest
}

function toolContentText(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map(toolContentText).filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join('\n') : null
  }
  const record = asRecord(content)
  if (!record) return null
  if (record.type === 'diff') {
    const path = typeof record.path === 'string' ? record.path : 'file'
    return path
  }
  if (record.type === 'terminal' && typeof record.terminalId === 'string') {
    return `terminal ${record.terminalId}`
  }
  return contentText(record)
}

function clipDiff(text: string, maxLines = 240): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more lines`
}

function collectContentDiffs(content: unknown, diffs: ActivityDiff[]): void {
  if (!content) return
  if (Array.isArray(content)) {
    for (const item of content) collectContentDiffs(item, diffs)
    return
  }
  const record = asRecord(content)
  if (!record) return
  if (record.type === 'diff') {
    diffs.push({
      path: typeof record.path === 'string' ? record.path : '',
      oldText: clipDiff(typeof record.oldText === 'string' ? record.oldText : ''),
      newText: clipDiff(typeof record.newText === 'string' ? record.newText : '')
    })
  }
  if (record.content !== undefined) collectContentDiffs(record.content, diffs)
}

function extractDiffs(update: SessionUpdate['update']): ActivityDiff[] {
  const diffs: ActivityDiff[] = []
  collectContentDiffs(update.content, diffs)
  const oldText = pickPreferred(update.rawInput, ['oldText', 'old_string', 'old_str', 'before'])
  const newText = pickPreferred(update.rawInput, ['newText', 'new_string', 'new_str', 'after'])
  const path =
    pickPreferred(update.rawInput, ['path', 'file', 'file_path', 'target_file', 'filename']) ??
    diffs[0]?.path ??
    ''
  if (oldText !== null && newText !== null && (oldText.length > 0 || newText.length > 0)) {
    const already = diffs.some((diff) => diff.oldText === oldText && diff.newText === newText)
    if (!already) diffs.push({ path, oldText: clipDiff(oldText), newText: clipDiff(newText) })
  }
  return diffs
}

function goalToolMessage(update: SessionUpdate['update']): string | null {
  const name = `${update.name ?? ''} ${update.title ?? ''} ${update.kind ?? ''}`.toLowerCase()
  if (!name.includes('update_goal')) return null
  const record = asRecord(update.rawInput)
  if (!record) return null
  return firstString(record, ['message', 'text', 'blocked_reason', 'blockedReason'])
}

function countField(update: SessionUpdate['update']): string | null {
  const done = update.completed_deliverables ?? update.completedDeliverables
  const total = update.total_deliverables ?? update.totalDeliverables
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return null
  return `${done}/${total}`
}

function goalUpdateTitle(update: SessionUpdate['update']): string {
  const step =
    update.current_deliverable_title?.trim() ||
    update.currentDeliverableTitle?.trim() ||
    update.message?.trim() ||
    update.objective?.trim() ||
    'Goal'
  const count = countField(update)
  return count ? `${count} · ${step}` : step
}

function goalUpdateDetail(update: SessionUpdate['update']): string | null {
  const parts = [update.objective?.trim(), update.message?.trim()].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n') : null
}

function summarizeTool(update: SessionUpdate['update']): {
  title: string
  detail: string | null
  toolKind: string | null
  diffs: ActivityDiff[]
} {
  const toolKind = update.kind?.trim() || null
  const diffs = extractDiffs(update)
  const paths = (update.locations ?? []).map((location) => location.path).filter((path): path is string => Boolean(path))
  const goalMessage = goalToolMessage(update)
  if (goalMessage) {
    return { title: clip(goalMessage, 160), detail: goalMessage, toolKind: 'update_goal', diffs }
  }
  const input = diffs.length > 0 ? null : summarizeBlob(update.rawInput, INPUT_KEYS)
  const output =
    diffs.length > 0 ? null : (toolContentText(update.content) ?? summarizeBlob(update.rawOutput, OUTPUT_KEYS))
  const chunks = [
    input,
    paths.length > 0 ? paths.join('\n') : null,
    diffs.length > 0 ? null : output
  ].filter((chunk): chunk is string => Boolean(chunk))
  const unique: string[] = []
  for (const chunk of chunks) {
    if (unique.includes(chunk)) continue
    unique.push(chunk)
  }
  const detail = unique.length > 0 ? clip(unique.join('\n\n')) : null

  const inputLine = input?.split('\n').find((line) => line.trim())?.trim()
  const title =
    (!isWeakLabel(update.title) && update.title) ||
    (diffs[0]?.path ? fileName(diffs[0].path) : null) ||
    (inputLine ? clip(inputLine, 96) : null) ||
    (paths[0] ? fileName(paths[0]) : null) ||
    update.name ||
    (toolKind ? toolKind.replace(/_/g, ' ') : null) ||
    'Tool'

  return { title, detail, toolKind, diffs }
}

function planDetail(update: SessionUpdate['update']): string | null {
  const entries = update.entries
  if (!entries || entries.length === 0) return update.title ?? null
  return entries
    .map((entry) => {
      const mark = entry.status === 'completed' ? 'done' : entry.status === 'in_progress' ? 'now' : 'todo'
      return `${mark}  ${entry.content ?? ''}`.trim()
    })
    .join('\n')
}

function handleSessionUpdate(event: SessionUpdate): void {
  const sessionId = event.sessionId
  const update = event.update ?? {}
  const kind = update.sessionUpdate ?? ''
  const bound = boundFields(sessionId)

  if (kind === 'agent_thought_chunk') {
    const text = contentText(update.content)
    if (!text) return
    emitActivity({
      kind: 'thought',
      sessionId,
      ...bound,
      title: 'Thinking',
      detail: text,
      status: 'running',
      coalesceKey: `thought:${sessionId}`
    })
    return
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = update.toolCallId || update.title || 'tool'
    const summary = summarizeTool(update)
    emitActivity({
      kind: 'tool',
      sessionId,
      ...bound,
      title: summary.title,
      detail: summary.detail,
      toolKind: summary.toolKind,
      diffs: summary.diffs,
      status: toolStatus(update.status),
      coalesceKey: `tool:${sessionId}:${toolCallId}`
    })
    return
  }

  if (kind === 'goal_updated') {
    const title = goalUpdateTitle(update)
    emitActivity({
      kind: 'goal',
      sessionId,
      ...bound,
      title,
      detail: goalUpdateDetail(update),
      status: 'running',
      coalesceKey: `goal:${bound.chatId ?? sessionId}`
    })
    return
  }

  if (kind === 'plan') {
    emitActivity({
      kind: 'plan',
      sessionId,
      ...bound,
      title: update.title || 'Plan',
      detail: planDetail(update),
      status: 'running',
      coalesceKey: `plan:${sessionId}`
    })
    return
  }

  if (kind === 'agent_message_chunk') {
    emitActivity({
      kind: 'write',
      sessionId,
      ...bound,
      title: 'Writing reply',
      detail: null,
      status: 'running',
      coalesceKey: `write:${sessionId}`
    })
  }
}

export function startActivityBridge(): void {
  if (started) return
  started = true
  onSessionUpdate(handleSessionUpdate)
}

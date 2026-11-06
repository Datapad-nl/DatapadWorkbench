import type { PermissionMode, PermissionRequest } from '../shared/types'
import { normalizePermissionMode } from '../shared/types'

export type PermissionOption = {
  optionId: string
  kind?: string
  name?: string
}

export type PermissionParams = {
  sessionId?: string
  options?: PermissionOption[]
  toolCall?: {
    title?: string
    kind?: string
    name?: string
    rawInput?: unknown
    locations?: Array<{ path?: string }>
  }
}

export type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

type PendingAsk = {
  request: PermissionRequest
  sessionId: string
  options: PermissionOption[]
  resolve: (outcome: PermissionOutcome) => void
}

const sessionModes = new Map<string, PermissionMode>()
const sessionChats = new Map<string, string>()
/** Sessions whose turn the user stopped. Tools they ask for afterwards are refused. */
const stoppedSessions = new Set<string>()
const pending = new Map<string, PendingAsk>()
const promptListeners = new Set<(request: PermissionRequest) => void>()
const settleListeners = new Set<(request: PermissionRequest) => void>()
const denyListeners = new Set<(request: PermissionRequest) => void>()

const DENY_KIND = new Set(['edit', 'delete', 'move', 'execute', 'write'])
const DENY_NAME = /\b(write|edit|delete|remove|replace|apply_patch|search_replace|run_terminal|bash|shell|spawn|exec)\b/i

export function bindPermissionSession(sessionId: string, chatId: string, mode: PermissionMode): void {
  sessionChats.set(sessionId, chatId)
  sessionModes.set(sessionId, normalizePermissionMode(mode))
}

export function setSessionMode(sessionId: string, mode: PermissionMode): void {
  sessionModes.set(sessionId, normalizePermissionMode(mode))
}

export function modeForSession(sessionId: string): PermissionMode {
  // A session we cannot place asks, so an unknown request never runs on its own.
  return sessionModes.get(sessionId) ?? 'ask'
}

/** Forget a deleted chat's sessions, so they stop counting for fallbackSessionId. */
export function forgetChatSessions(chatId: string): void {
  for (const [sessionId, owner] of [...sessionChats]) {
    if (owner !== chatId) continue
    sessionChats.delete(sessionId)
    sessionModes.delete(sessionId)
    stoppedSessions.delete(sessionId)
  }
}

export function markSessionStopped(sessionId: string): void {
  if (sessionId) stoppedSessions.add(sessionId)
}

export function clearSessionStopped(sessionId: string): void {
  stoppedSessions.delete(sessionId)
}

export function isSessionStopped(sessionId: string): boolean {
  return Boolean(sessionId) && stoppedSessions.has(sessionId)
}

export function chatIdForSession(sessionId: string): string | null {
  return sessionChats.get(sessionId) ?? null
}

export function fallbackSessionId(): string {
  if (sessionModes.size === 1) return [...sessionModes.keys()][0]
  return ''
}

export function onPermissionPrompt(listener: (request: PermissionRequest) => void): () => void {
  promptListeners.add(listener)
  return () => {
    promptListeners.delete(listener)
  }
}

export function onPermissionSettled(listener: (request: PermissionRequest) => void): () => void {
  settleListeners.add(listener)
  return () => {
    settleListeners.delete(listener)
  }
}

export function onPermissionDenied(listener: (request: PermissionRequest) => void): () => void {
  denyListeners.add(listener)
  return () => {
    denyListeners.delete(listener)
  }
}

export function noteDeniedPermission(sessionId: string, params: PermissionParams): void {
  const chatId = chatIdForSession(sessionId)
  if (!chatId) return
  const request: PermissionRequest = {
    requestId: `deny:${sessionId}:${Date.now()}`,
    chatId,
    title: `Blocked: ${requestTitle(params)}`,
    detail: requestDetail(params),
    toolKind: params.toolCall?.kind ?? params.toolCall?.name ?? null
  }
  for (const listener of denyListeners) listener(request)
}

function toolVariant(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  return String((input as { variant?: unknown }).variant ?? '')
}

function isExactPlanGate(value: string, gate: 'exit' | 'enter'): boolean {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ')
  if (gate === 'exit') {
    return (
      normalized === 'exit plan mode' ||
      normalized === 'plan: exit' ||
      normalized === 'plan exit' ||
      normalized === 'exit plan'
    )
  }
  return (
    normalized === 'enter plan mode' ||
    normalized === 'plan: enter' ||
    normalized === 'plan enter' ||
    normalized === 'enter plan'
  )
}

export function isExitPlanTool(params: PermissionParams): boolean {
  const tool = params.toolCall
  return [tool?.name, tool?.title, tool?.kind, toolVariant(tool?.rawInput)].some((value) =>
    isExactPlanGate(value ?? '', 'exit')
  )
}

export function isEnterPlanTool(params: PermissionParams): boolean {
  const tool = params.toolCall
  return [tool?.name, tool?.title, tool?.kind, toolVariant(tool?.rawInput)].some((value) =>
    isExactPlanGate(value ?? '', 'enter')
  )
}

export function isPlanGateTool(params: PermissionParams): boolean {
  return isExitPlanTool(params) || isEnterPlanTool(params)
}

export function resolveChatPlanApproval(chatId: string, decision: 'allow' | 'deny'): boolean {
  let found = false
  for (const item of [...pending.values()]) {
    if (item.request.chatId !== chatId) continue
    if (!isPlanGateText(`${item.request.title} ${item.request.toolKind ?? ''}`)) continue
    item.resolve(outcomeFor(item.options, decision))
    found = true
  }
  return found
}

/** "Exit plan mode", "exit_plan_mode", "Plan: enter", "enter-plan" and the like. */
export function isPlanGateText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ')
  return /\b(exit|enter) plan\b|\bplan:? (exit|enter)\b/.test(normalized)
}

export function isMutatingTool(kind?: string, title?: string, name?: string): boolean {
  const toolKind = (kind ?? '').toLowerCase()
  if (DENY_KIND.has(toolKind)) return true
  if (toolKind === 'read' || toolKind === 'search' || toolKind === 'think' || toolKind === 'fetch') {
    return false
  }
  return DENY_NAME.test(`${title ?? ''} ${name ?? ''}`)
}

/**
 * The option that gives this answer. A "once" option comes first, so the agent asks again for the next
 * call: an "always" answer would let later edits run unasked, before their checkpoint copy is taken.
 */
export function pickOption(
  options: PermissionOption[],
  want: 'allow' | 'deny'
): PermissionOption | null {
  const matches = options.filter((option) => {
    const kind = (option.kind ?? '').toLowerCase()
    if (want === 'allow') return kind.startsWith('allow')
    return kind.startsWith('reject') || kind.startsWith('deny')
  })
  const match = matches.find((option) => (option.kind ?? '').toLowerCase().endsWith('_once')) ?? matches[0]
  if (match) return match
  return want === 'allow' ? (options[0] ?? null) : null
}

export function outcomeFor(options: PermissionOption[], want: 'allow' | 'deny'): PermissionOutcome {
  const option = pickOption(options, want)
  if (!option) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

function requestTitle(params: PermissionParams): string {
  const tool = params.toolCall
  return tool?.title?.trim() || tool?.name?.trim() || tool?.kind?.trim() || 'Tool'
}

function requestDetail(params: PermissionParams): string | null {
  const paths = (params.toolCall?.locations ?? [])
    .map((location) => location.path)
    .filter((path): path is string => Boolean(path))
  if (paths.length > 0) return paths.join('\n')
  const input = params.toolCall?.rawInput
  if (typeof input === 'string' && input.trim()) return input.trim().slice(0, 240)
  if (input && typeof input === 'object') {
    try {
      return JSON.stringify(input).slice(0, 240)
    } catch {
      return null
    }
  }
  return null
}

export function decidePermission(mode: PermissionMode, params: PermissionParams): 'allow' | 'deny' | 'ask' {
  if (isExitPlanTool(params)) return 'allow'
  if (isEnterPlanTool(params)) return mode === 'plan' ? 'allow' : 'ask'
  if (mode === 'accept') return 'allow'
  if (mode === 'ask') return 'ask'
  const tool = params.toolCall
  return isMutatingTool(tool?.kind, tool?.title, tool?.name) ? 'deny' : 'allow'
}

export function askPermission(
  requestId: string,
  sessionId: string,
  params: PermissionParams
): Promise<PermissionOutcome> {
  const chatId = chatIdForSession(sessionId)
  // Nobody can be asked, so the tool does not run.
  if (!chatId) return Promise.resolve(outcomeFor(params.options ?? [], 'deny'))

  const request: PermissionRequest = {
    requestId,
    chatId,
    title: requestTitle(params),
    detail: requestDetail(params),
    toolKind: params.toolCall?.kind ?? params.toolCall?.name ?? null
  }

  return new Promise((resolve) => {
    pending.set(requestId, {
      request,
      sessionId,
      options: params.options ?? [],
      resolve: (outcome) => {
        pending.delete(requestId)
        resolve(outcome)
        for (const listener of settleListeners) listener(request)
      }
    })
    for (const listener of promptListeners) listener(request)
  })
}

export function resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
  const item = pending.get(requestId)
  if (!item) return false
  item.resolve(outcomeFor(item.options, decision))
  return true
}

export function cancelSessionPermissions(sessionId: string): void {
  for (const item of [...pending.values()]) {
    if (item.sessionId === sessionId) item.resolve({ outcome: { outcome: 'cancelled' } })
  }
}

export function cancelChatPermissions(chatId: string): void {
  for (const item of [...pending.values()]) {
    if (item.request.chatId === chatId) item.resolve({ outcome: { outcome: 'cancelled' } })
  }
}

/** The cards still waiting for an answer, so a reloaded window can show them again. */
export function pendingPermissionRequests(): PermissionRequest[] {
  return [...pending.values()].map((item) => item.request)
}

export function cancelAllPermissions(): void {
  for (const item of [...pending.values()]) {
    item.resolve({ outcome: { outcome: 'cancelled' } })
  }
}

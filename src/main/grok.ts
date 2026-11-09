import { homedir } from 'os'
import type {
  AgentCommand,
  Attachment,
  Chat,
  ChatAgent,
  ChatEvent,
  ChatLiveState,
  ChatPlan,
  FileMention,
  PermissionMode,
  PlanEntry,
  PlanVerdict,
  Project
} from '../shared/types'
import { chatAgentLabel, normalizeChatAgent, normalizePermissionMode } from '../shared/types'
import {
  abortAgent,
  acpModeIdFor,
  agentGeneration,
  bindExitPlanSession,
  cancelSession,
  clearQueuedExitPlanVerdict,
  contentText,
  ensureAgent,
  hasOtherActivePrompts,
  previousTurnEnded,
  hasPendingExitPlan,
  hasLiveSession,
  loadSession,
  newSession,
  onExitPlanPrompt,
  onSessionUpdate,
  promptIsolated,
  promptSession,
  queueExitPlanVerdict,
  grokCommands,
  resolveExitPlan,
  sessionCommands,
  setAcpSessionMode,
  type SessionUpdate
} from './acp'
import { emitNotice, finishTurn, startTurn } from './activity'
import { getClaudeCliInfo } from './claudeCli'
import { finishCheckpoint, snapshotTouched, startCheckpoint, rewindTo } from './checkpoints'
import { id, now, titleFromPrompt } from './ids'
import {
  bindPermissionSession,
  cancelChatPermissions,
  cancelSessionPermissions,
  clearSessionStopped,
  forgetChatSessions,
  markSessionStopped,
  pendingPermissionRequests,
  resolveChatPlanApproval,
  setSessionMode
} from './permissions'
import { cancelChatQuestions, cancelSessionQuestions, pendingQuestionRequests } from './questions'
import { clearGrokPlanApproval, grokBuildSignedIn, readGrokPlan } from './sessions'
import { chatWorkingDir, isolateChatIfNeeded } from './git'
import { projectSessionRules } from './intake'
import { getApiKey, getChat, listChats, listProjects, mutateChat } from './store'
import { saveVisual, visualFromUpdate } from './visuals'
import { STEP_BREAK, plainReply } from '../shared/steps'

const BTW_INSTRUCTION = [
  'You are answering a /btw aside on the ongoing main task in this chat.',
  'The main task keeps running in parallel — do not take it over, re-do it, or repeat its work.',
  'You have the current task context below. Use it so your answer fits the work in progress.',
  'If the user is correcting, steering, or giving feedback on the main work, start your reply with STEER on its own first line, then a blank line, then a short reply to the user.',
  'If they are only asking a side question unrelated to changing the work, do not write STEER.',
  'Do not edit files or run mutating commands. Read the project only if the context is not enough.'
].join(' ')

const BTW_PREFIX = 'Side question — answer this without dropping the main task:'
const ASIDE_CONTEXT_MAX = 12_000
const ASIDE_MESSAGE_MAX = 1_800
/** An aside that never answers would hold its agent process forever. */
const ASIDE_TIMEOUT_MS = 10 * 60_000

const PLAN_MODE_INSTRUCTION = [
  'You are in plan mode.',
  'Explore the codebase and write a concrete implementation plan.',
  'Do not edit files, apply patches, or run mutating commands.',
  'Read, search, and inspect only.',
  'Use the plan tool to list ordered steps.',
  'Wait for the user to approve before implementing.'
].join(' ')

type SteerNote = {
  text: string
  attachments: Attachment[]
  /** The steer's own message, taken out of the chat if the steer is dropped. */
  messageId?: string
  /** The voice conversation it was said in. Ending that conversation drops it. */
  conversation?: string
}

type FollowUp = {
  text: string
  attachments?: Attachment[]
}

/** Resolves a turn's wait when the user stops it. */
const STOP = Symbol('stop')

/** A turn the user stopped before it had a reply. */
class TurnStopped extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * One turn of one chat, from the moment it is accepted until its reply is saved.
 * It is registered before anything is awaited, so every guard sees it.
 */
type Turn = {
  id: number
  chatId: string
  /** 'preparing' until the prompt goes to the agent. */
  phase: 'preparing' | 'streaming'
  sessionId: string | null
  agent: ChatAgent
  /** The agent process this turn prompts. Stop kills only that one. */
  agentGeneration: number
  cancelled: boolean
  /** Cancelled by a steer, which runs as soon as this turn ends. The session is kept. */
  steered: boolean
  draft: string
  /** A tool ran since the last text, so the next text starts a new step. */
  stepBreak: boolean
  pendingDelta: string
  flushTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  checkpointId: string | null
  /** A plan card came up for approval during this turn. Only that card's early verdict is kept. */
  planShown: boolean
  stopped: Promise<typeof STOP>
  signalStop: () => void
  /** Stop gave up on an agent that ignores the cancel and has other chats to answer. */
  abandoned: Promise<typeof STOP>
  signalAbandon: () => void
  ended: Promise<void>
  signalEnd: () => void
}

/** How long a stopped turn has to answer before its agent process is killed. */
const STOP_GRACE_MS = 2_000
const DELTA_FLUSH_MS = 50

const turns = new Map<string, Turn>()
const sessionTurns = new Map<string, Turn>()
/** Prompts of stopped turns that the agent did not cancel, by session, until they end. */
const abandonedPrompts = new Map<string, Promise<void>>()
/** Chats whose rewind is restoring files and messages. */
const rewinding = new Set<string>()
const asideAborts = new Map<string, Set<AbortController>>()
const asideSteers = new Map<string, SteerNote[]>()
let nextGen = 1
const livePlans = new Map<string, ChatPlan>()
const sessionChats = new Map<string, string>()
const liveListeners = new Set<(event: ChatEvent) => void>()

function emitLive(event: ChatEvent): void {
  for (const listener of liveListeners) listener(event)
}

export function onChatLive(listener: (event: ChatEvent) => void): () => void {
  liveListeners.add(listener)
  return () => {
    liveListeners.delete(listener)
  }
}

function planStatus(value?: string): PlanEntry['status'] {
  const status = (value ?? '').toLowerCase()
  if (status === 'completed' || status === 'done') return 'completed'
  if (status === 'in_progress' || status === 'in-progress' || status === 'now') return 'in_progress'
  return 'pending'
}

function planFromUpdate(update: SessionUpdate['update']): ChatPlan | null {
  const entries = (update.entries ?? [])
    .map((entry) => ({
      content: (entry.content ?? '').trim(),
      status: planStatus(entry.status)
    }))
    .filter((entry) => entry.content.length > 0)
  const title = update.title?.trim() || 'Plan'
  if (entries.length === 0 && title === 'Plan') return null
  return { title, entries }
}

function mergePlan(base: ChatPlan | undefined, next: Partial<ChatPlan> & Pick<ChatPlan, 'title'>): ChatPlan {
  return {
    title: next.title || base?.title || 'Plan',
    entries: next.entries ?? base?.entries ?? [],
    markdown: next.markdown ?? base?.markdown,
    awaitingApproval: next.awaitingApproval ?? base?.awaitingApproval
  }
}

function planHasBody(plan?: ChatPlan | null): boolean {
  return Boolean(plan?.markdown?.trim() || (plan?.entries && plan.entries.length > 0))
}

function attachSession(chat: Chat, options: { silent?: boolean } = {}): void {
  if (!chat.grokSessionId) return
  const mode = normalizePermissionMode(chat.mode)
  sessionChats.set(chat.grokSessionId, chat.id)
  setSessionMode(chat.grokSessionId, mode)
  bindPermissionSession(chat.grokSessionId, chat.id, mode)
  bindExitPlanSession(chat.grokSessionId, chat.id, options)
}

async function persistPlan(chatId: string, plan: ChatPlan): Promise<void> {
  livePlans.set(chatId, plan)
  emitLive({ type: 'plan', chatId, plan })
  try {
    await mutateChat(chatId, (chat) => {
      chat.plan = plan
    })
  } catch {
    // live card still updates even if disk write fails
  }
}

function diskToPlan(disk: ReturnType<typeof readGrokPlan>): ChatPlan | null {
  if (!disk) return null
  return {
    title: disk.plan.title,
    entries: disk.plan.entries,
    markdown: disk.markdown || disk.plan.markdown,
    awaitingApproval: disk.awaitingApproval
  }
}

function applyDiskPlan(chat: Chat): Chat {
  if (!chat.grokSessionId) return chat
  const disk = diskToPlan(readGrokPlan(chat.grokSessionId))
  if (!disk) return chat
  const pending = hasPendingExitPlan(chat.id)
  if (!disk.awaitingApproval && !pending) {
    if (!chat.plan?.awaitingApproval) return chat
    const cleared = { ...chat.plan, awaitingApproval: false }
    livePlans.set(chat.id, cleared)
    return { ...chat, plan: cleared }
  }
  const plan = mergePlan(chat.plan ?? undefined, { ...disk, awaitingApproval: true })
  livePlans.set(chat.id, plan)
  return { ...chat, plan }
}

function isExitPlanUpdate(update: SessionUpdate['update']): boolean {
  const input = update.rawInput
  const variant =
    input && typeof input === 'object' && !Array.isArray(input)
      ? String((input as { variant?: unknown }).variant ?? '')
      : ''
  const fields = [update.name, update.title, update.kind, variant].map((value) =>
    (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ')
  )
  return fields.some(
    (value) =>
      value === 'exit plan mode' ||
      value === 'plan: exit' ||
      value === 'plan exit' ||
      value === 'exit plan'
  )
}

async function hydrateExitPlan(chatId: string, sessionId: string, markdown = ''): Promise<void> {
  const disk = diskToPlan(readGrokPlan(sessionId))
  const live = livePlans.get(chatId)
  const text = markdown || disk?.markdown || live?.markdown || ''
  const entries = live?.entries?.length ? live.entries : disk?.entries ?? []
  // A plan waits for the user only while the agent asks, or while Grok's own file says so.
  // A tool update alone does not bring an answered card back.
  const pending = hasPendingExitPlan(chatId)
  if (!pending && !disk?.awaitingApproval) return
  if (!text.trim() && entries.length === 0 && !pending) return
  const title =
    (live?.title && live.title !== 'Plan' && live.title !== 'No plan written yet' ? live.title : null) ||
    (disk?.title && disk.title !== 'No plan written yet' ? disk.title : null) ||
    (text.trim() ? text.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan' : 'Waiting for approval')
  const turn = turns.get(chatId)
  if (turn) turn.planShown = true
  await persistPlan(
    chatId,
    mergePlan(live ?? disk ?? undefined, {
      title,
      entries,
      markdown: text || undefined,
      awaitingApproval: true
    })
  )
}

onExitPlanPrompt((input) => {
  void hydrateExitPlan(input.chatId, input.sessionId, input.markdown)
})

onSessionUpdate((event) => {
  const chatId = sessionChats.get(event.sessionId)
  if (event.update.sessionUpdate === 'available_commands_update') {
    if (chatId) emitLive({ type: 'commands', chatId, commands: sessionCommands(event.sessionId) })
    return
  }
  if (event.update.sessionUpdate === 'current_mode_update') {
    const modeId = event.update.currentModeId || event.update.modeId || ''
    if (chatId && /plan|architect/i.test(modeId)) {
      void (async () => {
        try {
          const current = await getChat(chatId)
          if (normalizePermissionMode(current.mode) === 'plan') return
          const saved = await mutateChat(chatId, (latest) => {
            const before = normalizePermissionMode(latest.mode)
            if (before === 'plan') return
            latest.prePlanMode = before
            latest.mode = 'plan'
          })
          if (saved.grokSessionId) {
            setSessionMode(saved.grokSessionId, 'plan')
            bindPermissionSession(saved.grokSessionId, saved.id, 'plan')
          }
          emitLive({ type: 'chat', chatId, chat: await getChat(chatId) })
        } catch {
          // mode chip still follows the next prompt
        }
      })()
    }
    return
  }
  if (event.update.sessionUpdate === 'plan') {
    const plan = planFromUpdate(event.update)
    if (!plan || !chatId) return
    const current = livePlans.get(chatId)
    void persistPlan(
      chatId,
      mergePlan(current, { ...plan, awaitingApproval: current?.awaitingApproval })
    )
    return
  }
  if (event.update.sessionUpdate === 'tool_call' || event.update.sessionUpdate === 'tool_call_update') {
    if (chatId && isExitPlanUpdate(event.update)) {
      void hydrateExitPlan(chatId, event.sessionId)
    }
    if (chatId) void snapshotTouched(chatId, event.update)
    showVisual(event.sessionId, event.update)
    const turn = sessionTurns.get(event.sessionId)
    if (turn?.draft.trim()) turn.stepBreak = true
    return
  }
  if (event.update.sessionUpdate !== 'agent_message_chunk') return
  const text = contentText(event.update.content)
  if (!text) return
  // Text with no turn waiting for it is from a turn that already ended.
  const turn = sessionTurns.get(event.sessionId)
  if (!turn) return
  const chunk = turn.stepBreak && turn.draft.trim() ? STEP_BREAK + text : text
  turn.stepBreak = false
  pushDelta(turn, chunk)
})

const shownVisuals = new Set<string>()

/** Put a `show_visual` page into the reply as a block the chat renders in a frame. */
function showVisual(sessionId: string, update: SessionUpdate['update']): void {
  const turn = sessionTurns.get(sessionId)
  const key = `${sessionId}:${update.toolCallId ?? ''}`
  if (!turn || !update.toolCallId || shownVisuals.has(key)) return
  const visual = visualFromUpdate(update)
  if (!visual) return
  shownVisuals.add(key)
  pushDelta(turn, saveVisual(visual.html, visual.title))
}

/** Add reply text to a turn. The window gets it in batches, tagged with the turn. */
function pushDelta(turn: Turn, text: string): void {
  turn.draft += text
  turn.pendingDelta += text
  if (turn.flushTimer) return
  turn.flushTimer = setTimeout(() => flushDelta(turn), DELTA_FLUSH_MS)
}

function flushDelta(turn: Turn): void {
  if (turn.flushTimer) clearTimeout(turn.flushTimer)
  turn.flushTimer = null
  if (!turn.pendingDelta) return
  const text = turn.pendingDelta
  turn.pendingDelta = ''
  emitLive({ type: 'delta', chatId: turn.chatId, turnId: turn.id, text })
}

/** The slash commands the chat's agent announced for its current session. */
export async function chatCommands(chatId: string): Promise<AgentCommand[]> {
  const chat = await getChat(chatId)
  if (normalizeChatAgent(chat.agent) === 'grok') return grokCommands(chat.grokSessionId ?? null)
  return chat.grokSessionId ? sessionCommands(chat.grokSessionId) : []
}

/** True from the moment a turn is accepted, including while it prepares its session. */
export function isStreaming(chatId: string): boolean {
  return turns.has(chatId)
}

/** Claim the chat for a new turn. Nothing is awaited first, so two sends cannot both win. */
function reserveTurn(chatId: string): Turn {
  if (turns.has(chatId)) throw new Error('This chat is already generating')
  if (rewinding.has(chatId)) throw new Error('This chat is rewinding. Send again once it is done.')
  const turn = {
    id: nextGen++,
    chatId,
    phase: 'preparing',
    sessionId: null,
    // Set once the chat is read. Stop only uses it after the prompt is sent.
    agent: 'grok',
    agentGeneration: 0,
    cancelled: false,
    steered: false,
    draft: '',
    stepBreak: false,
    pendingDelta: '',
    flushTimer: null,
    killTimer: null,
    checkpointId: null,
    planShown: false
  } as Omit<Turn, 'stopped' | 'signalStop' | 'abandoned' | 'signalAbandon' | 'ended' | 'signalEnd'> as Turn
  turn.stopped = new Promise((resolve) => {
    turn.signalStop = () => resolve(STOP)
  })
  turn.abandoned = new Promise((resolve) => {
    turn.signalAbandon = () => resolve(STOP)
  })
  turn.ended = new Promise((resolve) => {
    turn.signalEnd = resolve
  })
  turns.set(chatId, turn)
  emitLive({ type: 'turn-start', chatId, turnId: turn.id })
  return turn
}

/** Await preparation work, unless the user stops the turn first. */
async function step<T>(turn: Turn, work: Promise<T>): Promise<T> {
  work.catch(() => {})
  const result = await Promise.race([work, turn.stopped])
  if (result === STOP || turn.cancelled) throw new TurnStopped()
  return result as T
}

function checkStopped(turn: Turn): void {
  if (turn.cancelled) throw new TurnStopped()
}

/** Drop the turn's live state. Only this turn's entries go: a newer turn keeps its own. */
function releaseTurn(turn: Turn): void {
  if (turns.get(turn.chatId) === turn) turns.delete(turn.chatId)
  if (turn.sessionId && sessionTurns.get(turn.sessionId) === turn) sessionTurns.delete(turn.sessionId)
  if (turn.flushTimer) clearTimeout(turn.flushTimer)
  if (turn.killTimer) clearTimeout(turn.killTimer)
  turn.flushTimer = null
  turn.killTimer = null
  // A verdict given early answers this turn's plan only.
  clearQueuedExitPlanVerdict(turn.chatId)
  if (turn.sessionId) {
    const prefix = `${turn.sessionId}:`
    for (const key of [...shownVisuals]) if (key.startsWith(prefix)) shownVisuals.delete(key)
  }
  turn.signalEnd()
}

function cancelAsides(chatId: string): void {
  const group = asideAborts.get(chatId)
  if (group) {
    for (const controller of group) controller.abort()
    asideAborts.delete(chatId)
  }
  asideSteers.delete(chatId)
}

export function stopStream(chatId: string): boolean {
  cancelAsides(chatId)
  cancelChatPermissions(chatId)
  // Project intake asks in the same chat but is not part of the turn.
  cancelChatQuestions(chatId, { keepIntake: true })
  resolveExitPlan(chatId, 'abandoned')
  const turn = turns.get(chatId)
  if (!turn) return false
  // A steer's cancel has no kill timer. Stop still ends an agent that ignores it.
  if (turn.cancelled && !turn.steered) return true
  turn.steered = false
  turn.cancelled = true
  turn.signalStop()
  const sessionId = turn.sessionId
  if (turn.phase !== 'streaming' || !sessionId) return true
  markSessionStopped(sessionId)
  cancelSessionPermissions(sessionId)
  cancelSessionQuestions(sessionId)
  try {
    cancelSession(sessionId)
  } catch {
    // the agent is already gone; its exit ends the turn
  }
  turn.killTimer = setTimeout(() => {
    turn.killTimer = null
    if (turns.get(chatId) !== turn) return
    // Killing the process would end every other chat on it. End only this turn.
    if (hasOtherActivePrompts(sessionId) || otherTurnOnAgent(turn)) turn.signalAbandon()
    else abortAgent(turn.agent, turn.agentGeneration)
  }, STOP_GRACE_MS)
  return true
}

/**
 * Cancel the running prompt so a queued steer goes out as soon as the agent stops, instead of
 * after the whole task. A turn still preparing is cancelled once its prompt is sent. If the agent
 * ignores the cancel, the steer waits for the turn to end.
 */
function interruptForSteer(turn: Turn): void {
  const sessionId = turn.sessionId
  if (turn.cancelled || turn.phase !== 'streaming' || !sessionId) return
  turn.cancelled = true
  turn.steered = true
  // The agent must not start new tool calls or wait on answers for the cancelled prompt.
  markSessionStopped(sessionId)
  cancelSessionPermissions(sessionId)
  cancelSessionQuestions(sessionId)
  try {
    cancelSession(sessionId)
  } catch {
    // the agent is already gone; its exit ends the turn
  }
}

/** Another chat's turn on the same agent, including one still preparing its prompt, that a kill would end. */
function otherTurnOnAgent(turn: Turn): boolean {
  for (const other of turns.values()) {
    if (other !== turn && !other.cancelled && other.agent === turn.agent) return true
  }
  return false
}

/** Stop the chat's turn and wait until it has saved, for steps that must not overlap a turn. */
export async function stopAndWait(chatId: string, timeoutMs = 5_000): Promise<void> {
  const turn = turns.get(chatId)
  stopStream(chatId)
  if (!turn) return
  let timer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([turn.ended, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))])
  if (timer) clearTimeout(timer)
}

export function hasRunningTurns(): boolean {
  return turns.size > 0
}

/** Stop every running turn and wait until each has saved what it streamed, for quitting. */
export async function stopAllTurnsAndWait(timeoutMs: number): Promise<void> {
  await Promise.all([...turns.keys()].map((chatId) => stopAndWait(chatId, timeoutMs)))
}

/** Forget a deleted chat. */
export function forgetChat(chatId: string): void {
  for (const [sessionId, owner] of [...sessionChats]) {
    if (owner === chatId) sessionChats.delete(sessionId)
  }
  livePlans.delete(chatId)
  asideSteers.delete(chatId)
  forgetChatSessions(chatId)
}

/** Running turns and open requests, for a window that loads mid-turn. */
export function liveState(): ChatLiveState {
  // Text still held back goes out first, so the draft below is exactly what was sent.
  for (const turn of turns.values()) flushDelta(turn)
  return {
    turns: [...turns.values()].map((turn) => ({ chatId: turn.chatId, turnId: turn.id, draft: turn.draft })),
    permissions: pendingPermissionRequests(),
    questions: pendingQuestionRequests()
  }
}

function promptForMentions(text: string, mentions?: FileMention[]): string {
  if (!mentions || mentions.length === 0) return text
  const list = mentions
    .map((item) => `- ${item.path}${item.kind === 'folder' ? '/' : ''}`)
    .join('\n')
  const block = `The user referenced these project paths. Read them before answering.\n${list}`
  // A slash command only runs when it starts the prompt.
  if (isSlashCommand(text)) return `${text}\n\n${block}`
  return text.trim() ? `${block}\n\n${text}` : block
}

function isSlashCommand(text: string): boolean {
  return /^\/\S/.test(text.trimStart())
}

function promptForMode(mode: PermissionMode, text: string): string {
  if (mode !== 'plan' || isSlashCommand(text)) return text
  if (!text.trim()) return PLAN_MODE_INSTRUCTION
  return `${PLAN_MODE_INSTRUCTION}\n\n${text}`
}

export async function rewindChat(chatId: string, checkpointId: string, cwd: string | null): Promise<Chat> {
  if (rewinding.has(chatId)) throw new Error('This chat is already rewinding.')
  // No new turn until the files and messages are back, or it would run on half of each.
  rewinding.add(chatId)
  try {
    // A rewind that cannot happen must not stop the turn running now.
    const { checkpoints = [] } = await getChat(chatId)
    if (!checkpoints.some((item) => item.id === checkpointId)) throw new Error('Checkpoint not found')
    // A running turn would write its reply after the rewind. Stop it and let it save first.
    await stopAndWait(chatId)
    if (isStreaming(chatId)) throw new Error('This chat is still stopping. Try the rewind again.')
    await rewindTo(chatId, checkpointId, cwd)
  } finally {
    rewinding.delete(chatId)
  }
  livePlans.delete(chatId)
  const chat = await getChat(chatId)
  emitLive({ type: 'chat', chatId, chat })
  return chat
}

async function applyAcpMode(sessionId: string | null | undefined, mode: PermissionMode): Promise<void> {
  if (!sessionId) return
  const want = mode === 'plan' ? 'plan' : 'default'
  const modeId = acpModeIdFor(sessionId, want)
  if (!modeId) return
  await setAcpSessionMode(sessionId, modeId)
}

/** Tell the session about a mode the chat already saved. The next turn applies it again if this fails. */
async function syncSessionMode(chat: Chat, options: { keepPlanMode?: boolean } = {}): Promise<void> {
  const sessionId = chat.grokSessionId
  if (!sessionId) return
  const mode = normalizePermissionMode(chat.mode)
  setSessionMode(sessionId, mode)
  bindPermissionSession(sessionId, chat.id, mode)
  if (mode !== 'plan' || options.keepPlanMode) clearGrokPlanApproval(sessionId, options)
  await applyAcpMode(sessionId, mode).catch(() => {})
}

function isChatGone(error: unknown): boolean {
  return error instanceof Error && error.message === 'Chat not found'
}

export async function setChatMode(chatId: string, mode: PermissionMode): Promise<Chat> {
  const loaded = await getChat(chatId)
  const next = normalizePermissionMode(mode)
  attachSession(loaded, { silent: next !== 'plan' })
  if (next === 'plan') {
    // Back to planning: a verdict left from leaving plan earlier in this turn no longer holds.
    clearQueuedExitPlanVerdict(chatId)
  } else {
    const answered = resolveExitPlan(chatId, 'abandoned')
    // The plan card can show before the agent asks. Answer that ask when it comes, in this turn only.
    const awaiting = (livePlans.get(chatId) ?? loaded.plan)?.awaitingApproval
    if (!answered && awaiting && turns.get(chatId)?.planShown) queueExitPlanVerdict(chatId, 'abandoned')
    resolveChatPlanApproval(chatId, 'deny')
  }
  let planChanged = false
  const saved = await mutateChat(chatId, (latest) => {
    const before = normalizePermissionMode(latest.mode)
    if (next === 'plan' && before !== 'plan') latest.prePlanMode = before
    if (next !== 'plan') latest.prePlanMode = null
    latest.mode = next
    const plan = livePlans.get(chatId) ?? latest.plan ?? loaded.plan
    if (next !== 'plan' && plan && (plan.awaitingApproval || loaded.plan?.awaitingApproval)) {
      latest.plan = planHasBody(plan) ? { ...plan, awaitingApproval: false } : null
      planChanged = true
    }
  })
  if (planChanged) {
    if (saved.plan) livePlans.set(chatId, saved.plan)
    else livePlans.delete(chatId)
  }
  await syncSessionMode(saved)
  const chat = await getChat(chatId)
  emitLive({ type: 'chat', chatId, chat })
  return chat
}

export async function settleChatPlan(chatId: string, verdict: PlanVerdict): Promise<boolean> {
  const outcome =
    verdict === 'approve' ? 'approved' : verdict === 'revise' ? 'cancelled' : 'abandoned'
  const live = isStreaming(chatId)
  const loaded = await getChat(chatId)

  attachSession(loaded, { silent: true })
  const continued = resolveExitPlan(chatId, outcome)
  // Clicked before the agent asked: answer its ask when it comes, in this turn only. A card restored
  // from an earlier turn does not answer a plan this turn has not shown yet.
  if (!continued && turns.get(chatId)?.planShown) queueExitPlanVerdict(chatId, outcome)
  if (verdict === 'approve') resolveChatPlanApproval(chatId, 'allow')
  if (verdict === 'abandon') resolveChatPlanApproval(chatId, 'deny')

  const saved = await mutateChat(chatId, (latest) => {
    if (verdict === 'revise') {
      latest.mode = 'plan'
    } else {
      // Back to the mode the chat had before it planned.
      const before = latest.prePlanMode ? normalizePermissionMode(latest.prePlanMode) : null
      latest.mode = before && before !== 'plan' ? before : 'accept'
      latest.prePlanMode = null
    }
    const plan = livePlans.get(chatId) ?? latest.plan ?? loaded.plan
    if (plan) {
      const keepBody = verdict !== 'abandon' && planHasBody(plan)
      latest.plan = keepBody ? { ...plan, awaitingApproval: false } : null
    }
  })
  if (saved.plan) livePlans.set(chatId, saved.plan)
  else livePlans.delete(chatId)
  await syncSessionMode(saved, { keepPlanMode: verdict === 'revise' })
  const chat = await getChat(chatId)
  emitLive({ type: 'chat', chatId, chat })
  return continued && live
}

export async function loadChat(chatId: string): Promise<Chat> {
  const chat = await getChat(chatId)
  attachSession(chat)
  if (chat.plan?.awaitingApproval && !hasPendingExitPlan(chat.id) && !planHasBody(chat.plan)) {
    livePlans.delete(chat.id)
    await mutateChat(chatId, (latest) => {
      latest.plan = null
    })
    if (chat.grokSessionId) clearGrokPlanApproval(chat.grokSessionId)
    const saved = await getChat(chatId)
    emitLive({ type: 'chat', chatId, chat: saved })
    return saved
  }
  return applyDiskPlan(chat)
}

async function resolveSession(chat: Chat, project: Project | undefined): Promise<{ chat: Chat; sessionId: string }> {
  const cwd = chatWorkingDir(chat, project?.path) || homedir()
  const agent = normalizeChatAgent(chat.agent)
  const bind = (sessionId: string): void => {
    sessionChats.set(sessionId, chat.id)
    bindPermissionSession(sessionId, chat.id, normalizePermissionMode(chat.mode))
    bindExitPlanSession(sessionId, chat.id)
  }
  if (chat.grokSessionId) {
    const sessionId = chat.grokSessionId
    const withPlan = applyDiskPlan(chat)
    if (withPlan.plan && withPlan.plan !== chat.plan) {
      const plan = withPlan.plan
      await mutateChat(chat.id, (latest) => {
        latest.plan = plan
      })
      chat = withPlan
    }
    bind(sessionId)
    if (hasLiveSession(sessionId)) return { chat, sessionId }
    try {
      await loadSession(sessionId, cwd, await projectSessionRules(project?.id), agent, chat.id)
      return { chat, sessionId }
    } catch {
      // Session is gone in this agent process. Prompting the dead id returns
      // an empty turn, so open a replacement session instead.
    }
  }
  const sessionId = await newSession(cwd, await projectSessionRules(project?.id), agent, chat.id)
  await mutateChat(chat.id, (latest) => {
    latest.grokSessionId = sessionId
  })
  chat = { ...chat, grokSessionId: sessionId }
  bind(sessionId)
  return { chat, sessionId }
}

async function appendUserMessage(
  chatId: string,
  content: string,
  attachments: Attachment[],
  mentions: FileMention[]
): Promise<Chat> {
  const loaded = await getChat(chatId)
  await mutateChat(chatId, (chat) => {
    // An imported chat reads its history from the agent's session file until it is saved here.
    if (chat.messages.length === 0 && loaded.messages.length > 0) chat.messages = loaded.messages
    chat.messages.push({
      id: id(),
      role: 'user',
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
      createdAt: now()
    })
    if (chat.title === 'New chat') {
      chat.title = content
        ? titleFromPrompt(content)
        : mentions[0]?.path ?? (attachments.length > 0 ? 'Screenshot' : 'New chat')
    }
  })
  return getChat(chatId)
}

/** Null when the chat's agent can run, otherwise what the user has to do. */
async function agentSignInError(agent: ChatAgent): Promise<string | null> {
  if (agent === 'claude') {
    return (await getClaudeCliInfo()).signedIn
      ? null
      : 'Run `claude auth login` so Claude Code can pick up this chat.'
  }
  return grokBuildSignedIn() || (await getApiKey())
    ? null
    : 'Run `grok login` so Grok Build can pick up this chat.'
}

/**
 * Save the user's message and start the reply. The chat is claimed before anything is awaited,
 * so a second send while this one prepares is refused. `done` settles once the reply is saved.
 */
export async function sendUserTurn(
  chatId: string,
  content: string,
  attachments: Attachment[] = [],
  mentions: FileMention[] = []
): Promise<{ chat: Chat; done: Promise<Chat | null> }> {
  const trimmed = content.trim()
  if (!trimmed && attachments.length === 0 && mentions.length === 0) throw new Error('Message is empty')
  const turn = reserveTurn(chatId)
  let chat: Chat
  try {
    chat = await appendUserMessage(chatId, trimmed, attachments, mentions)
  } catch (error) {
    releaseTurn(turn)
    emitLive({ type: 'error', chatId, turnId: turn.id, error: errorMessage(error) })
    throw error
  }
  emitLive({ type: 'chat', chatId, chat })
  return { chat, done: runTurn(turn) }
}

/** Run a reserved turn to the end. Its live state is always released, and exactly one done or error goes out. */
async function runTurn(turn: Turn, followUp?: FollowUp): Promise<Chat | null> {
  let saved: Chat | null = null
  let failure: unknown = null
  let failed = false
  try {
    saved = await turnBody(turn, followUp)
  } catch (error) {
    failed = true
    failure = error
  }
  if (turn.checkpointId) await finishCheckpoint(turn.chatId, turn.checkpointId).catch(() => null)
  if (saved) saved = await getChat(turn.chatId).catch(() => saved)
  flushDelta(turn)
  const streamed = turn.phase === 'streaming'
  releaseTurn(turn)
  if (streamed) finishTurn(turn.chatId, failed ? 'error' : 'done', failed ? errorMessage(failure) : undefined)
  if (failed) emitLive({ type: 'error', chatId: turn.chatId, turnId: turn.id, error: errorMessage(failure) })
  else if (saved) emitLive({ type: 'done', chatId: turn.chatId, turnId: turn.id, chat: saved })
  // The chat was deleted mid-turn. A window still showing it must not keep spinning.
  else emitLive({ type: 'error', chatId: turn.chatId, turnId: turn.id, error: 'Chat not found' })
  drainAsideSteers(turn.chatId)
  if (failed) throw failure
  return saved
}

/** The reply, or what was written before a stop or failure. Null when the chat was deleted. */
async function turnBody(turn: Turn, followUp?: FollowUp): Promise<Chat | null> {
  try {
    return await promptTurn(turn, followUp)
  } catch (error) {
    if (isChatGone(error)) return null
    const draft = turn.draft.trim()
    if (turn.cancelled || error instanceof TurnStopped || draft) return saveReply(turn, draft || stoppedReply(turn))
    throw error
  }
}

function stoppedReply(turn: Turn): string {
  return turn.steered ? '(interrupted to steer)' : '(stopped)'
}

async function promptTurn(turn: Turn, followUp?: FollowUp): Promise<Chat | null> {
  let chat = await step(turn, getChat(turn.chatId))
  const agent = normalizeChatAgent(chat.agent)
  turn.agent = agent
  const signInError = await step(turn, agentSignInError(agent))
  if (signInError) throw new Error(signInError)
  await step(turn, ensureAgent(agent))
  const project = (await step(turn, listProjects())).find((item) => item.id === chat.projectId)

  const followText = followUp?.text.trim() ?? ''
  const lastUser = [...chat.messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' &&
        (followUp || (message.kind !== 'btw' && message.kind !== 'steer'))
    )
  if (!followUp && !lastUser) throw new Error('Message is empty')
  if (!followUp && !chat.worktreePath && project?.path) {
    const siblings = (await step(turn, listChats())).filter(
      (item) => item.projectId === chat.projectId && item.id !== chat.id
    )
    // Not raced against stop: a worktree it makes must be saved, or it is lost.
    const isolated = await isolateChatIfNeeded({ ...chat }, project.path, lastUser!.content, {
      streaming: siblings.some((item) => isStreaming(item.id)),
      worktrees: siblings.filter((item) => item.worktreePath).length,
      chats: siblings.length
    })
    if (isolated.reason) {
      const { worktreePath, worktreeBranch } = isolated.chat
      await mutateChat(chat.id, (latest) => {
        latest.worktreePath = worktreePath
        latest.worktreeBranch = worktreeBranch
      })
      chat = { ...chat, worktreePath, worktreeBranch }
      emitLive({ type: 'chat', chatId: chat.id, chat: await getChat(chat.id) })
      emitNotice({
        chatId: chat.id,
        chatTitle: chat.title,
        title: 'Isolated worktree',
        detail: `${isolated.reason}\n${chat.worktreeBranch ?? ''}`
      })
    }
    checkStopped(turn)
  }
  const resolved = await step(turn, resolveSession(chat, project))
  chat = resolved.chat
  const sessionId = resolved.sessionId
  // A stopped turn the agent kept running. Prompting now would mix its reply into this one.
  const running = abandonedPrompts.get(sessionId)
  if (running) await step(turn, running)
  // No turn owns the session yet, so the last words of one that ended without saying so are dropped.
  await step(turn, previousTurnEnded(sessionId))
  const mode = normalizePermissionMode(chat.mode)
  await step(turn, applyAcpMode(sessionId, mode))

  const opening = followText || lastUser?.content || 'Screenshot'
  try {
    // Not raced against stop: the turn has to know its checkpoint to close it.
    const checkpoint = await startCheckpoint({
      chat,
      messageId: lastUser?.id ?? id(),
      label: opening,
      cwd: chatWorkingDir(chat, project?.path)
    })
    turn.checkpointId = checkpoint.id
    emitLive({ type: 'chat', chatId: chat.id, chat: await getChat(chat.id) })
  } catch {
    // turn still runs if checkpoint fails
  }
  checkStopped(turn)

  const userText = followText || lastUser!.content
  const mentioned = followText ? followText : promptForMentions(lastUser!.content, lastUser!.mentions)
  const cued = promptForMode(mode, mentioned)
  const images = followUp ? (followUp.attachments ?? []) : (lastUser!.attachments ?? [])

  // From here the agent owns the turn. Nothing is awaited until the prompt is sent.
  turn.phase = 'streaming'
  turn.sessionId = sessionId
  turn.agentGeneration = agentGeneration(agent)
  sessionTurns.set(sessionId, turn)
  clearSessionStopped(sessionId)
  sessionChats.set(sessionId, chat.id)
  bindPermissionSession(sessionId, chat.id, mode)
  startTurn({ chatId: chat.id, chatTitle: chat.title, sessionId, prompt: opening })
  const prompt = promptSession(sessionId, cued, images)
  prompt.catch(() => {})
  // A steer sent while the turn prepared. The prompt is in the session now, so the steer can follow it.
  if (asideSteers.has(chat.id)) interruptForSteer(turn)
  const result = await Promise.race([prompt.then(() => null), turn.abandoned])
  if (result === STOP) {
    // The agent is still answering. The session takes its next prompt once this one ends.
    const running: Promise<void> = prompt
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (abandonedPrompts.get(sessionId) === running) abandonedPrompts.delete(sessionId)
      })
    abandonedPrompts.set(sessionId, running)
    throw new TurnStopped()
  }

  // Commands like /compact finish without writing anything.
  const draft = turn.draft.trim()
  const reply =
    draft ||
    (turn.cancelled
      ? stoppedReply(turn)
      : isSlashCommand(userText)
        ? `Ran ${userText.trim().split(/\s/)[0]}`
        : '(empty response)')
  return saveReply(turn, reply)
}

async function saveReply(turn: Turn, content: string): Promise<Chat | null> {
  const sessionId = turn.sessionId
  // A stopped turn may finish after a rewind dropped its session. Keep it dropped.
  // A steered turn keeps it: the steer continues in the same session.
  const keepSession = (!turn.cancelled || turn.steered) && sessionId
  try {
    return await mutateChat(turn.chatId, (latest) => {
      const plan = livePlans.get(latest.id)
      if (plan) latest.plan = plan
      if (keepSession) latest.grokSessionId = sessionId
      latest.messages.push({
        id: id(),
        role: 'assistant',
        content,
        createdAt: now()
      })
    })
  } catch (error) {
    if (isChatGone(error)) return null
    throw error
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Grok request failed'
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `…${trimmed.slice(-max)}`
}

function stripBtwPrefix(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith(BTW_PREFIX)) return trimmed.slice(BTW_PREFIX.length).trim()
  return trimmed
}

function parseAsideReply(text: string): { steer: boolean; reply: string } {
  const trimmed = text.trim()
  const match = trimmed.match(/^STEER\b:?[ \t]*([\s\S]*)$/i)
  if (!match) return { steer: false, reply: trimmed }
  const rest = match[1].trim()
  return {
    steer: true,
    reply: rest || 'Noted — I’ll apply that to the current task.'
  }
}

function emitAsideDelta(chatId: string, messageId: string): (chunk: string) => void {
  let buffer = ''
  let ready = false
  return (chunk: string) => {
    const emit = (text: string): void => {
      if (text) emitLive({ type: 'aside-delta', chatId, messageId, text })
    }
    if (ready) {
      emit(chunk)
      return
    }
    buffer += chunk
    const header = buffer.match(/^\s*STEER\b:?[ \t]*/i)
    if (header) {
      const rest = buffer.slice(header[0].length).replace(/^\r?\n/, '')
      if (!rest && !/\n/.test(buffer)) return
      ready = true
      emit(rest)
      return
    }
    if (!/^\s*S(T(E(E(R)?)?)?)?:?\s*$/i.test(buffer)) {
      ready = true
      emit(buffer)
    }
  }
}

function queueAsideSteer(chatId: string, note: SteerNote): void {
  const text = note.text.trim()
  if (!text && note.attachments.length === 0) return
  const list = asideSteers.get(chatId) ?? []
  list.push({ ...note, text })
  asideSteers.set(chatId, list)
}

/** Voice conversations that have ended. What was said in one is not sent, even if it arrives late. */
const endedConversations = new Set<string>()

export function conversationEnded(conversation: string | undefined): boolean {
  return conversation !== undefined && endedConversations.has(conversation)
}

async function removeMessages(chatId: string, ids: Set<string>): Promise<Chat | null> {
  try {
    const chat = await mutateChat(chatId, (current) => {
      current.messages = current.messages.filter((message) => !ids.has(message.id))
    })
    emitLive({ type: 'chat', chatId, chat })
    return chat
  } catch {
    // the chat was deleted
    return null
  }
}

/** Ending a voice conversation takes back what was said in it and has not reached the agent. */
export async function endConversation(conversation: string): Promise<void> {
  endedConversations.add(conversation)
  for (const [chatId, list] of [...asideSteers]) {
    const kept = list.filter((note) => note.conversation !== conversation)
    if (kept.length === list.length) continue
    // Taken out before the await, so a turn ending meanwhile does not send them.
    if (kept.length > 0) asideSteers.set(chatId, kept)
    else asideSteers.delete(chatId)
    const dropped = new Set(
      list.flatMap((note) => (note.conversation === conversation && note.messageId ? [note.messageId] : []))
    )
    if (dropped.size > 0) await removeMessages(chatId, dropped)
  }
}

function takeAsideSteers(chatId: string): SteerNote[] {
  const list = asideSteers.get(chatId) ?? []
  asideSteers.delete(chatId)
  return list
}

function steerPrompt(notes: SteerNote[]): string {
  const line = (note: SteerNote): string =>
    note.text || (note.attachments.length > 0 ? 'See the attached screenshot.' : '')
  const body =
    notes.length === 1
      ? line(notes[0])
      : notes.map((note, index) => `${index + 1}. ${line(note)}`).join('\n')
  return [
    'The user sent this while you were working. Apply it and carry on with the current task from where you were. Do not restart from scratch unless they asked you to.',
    '',
    body
  ].join('\n')
}

function asideContext(chat: Chat, skipMessageId?: string): string {
  const lines: string[] = [`Chat: ${chat.title}`]
  const plan = livePlans.get(chat.id) ?? chat.plan
  if (plan) {
    lines.push(`Plan: ${plan.title}`)
    for (const entry of plan.entries) {
      lines.push(`- [${entry.status}] ${entry.content}`)
    }
  }
  const recent = chat.messages.filter(
    (message) => message.id !== skipMessageId && message.content.trim()
  )
  for (const message of recent.slice(-8)) {
    const who = message.role === 'user' ? 'User' : chatAgentLabel(normalizeChatAgent(chat.agent))
    const tag =
      message.kind === 'btw' ? ' (aside)' : message.kind === 'steer' ? ' (steer)' : ''
    lines.push(`${who}${tag}: ${clipText(plainReply(message.content), ASIDE_MESSAGE_MAX)}`)
  }
  const turn = turns.get(chat.id)
  const live = turn ? plainReply(turn.draft).trim() : ''
  if (live) {
    lines.push(`${chatAgentLabel(normalizeChatAgent(chat.agent))} (in progress): ${clipText(live, 3_000)}`)
  }
  else if (!turn) lines.push('The main task is not currently running.')
  return clipText(lines.join('\n'), ASIDE_CONTEXT_MAX)
}

function asidePrompt(question: string, context: string): string {
  return [
    BTW_INSTRUCTION,
    '',
    'Current main task:',
    context || '(no prior messages)',
    '',
    'Side question:',
    question
  ].join('\n')
}

/** Run the queued steers as one follow-up turn. A running turn is interrupted first, and drains them when it ends. */
function drainAsideSteers(chatId: string): void {
  const running = turns.get(chatId)
  if (running) {
    if (asideSteers.has(chatId)) interruptForSteer(running)
    return
  }
  const notes = takeAsideSteers(chatId)
  if (notes.length === 0) return
  const turn = reserveTurn(chatId)
  // runTurn reports its own failure as an error event.
  void runTurn(turn, {
    text: steerPrompt(notes),
    attachments: notes.flatMap((note) => note.attachments)
  }).catch(() => {})
}

async function startSteer(
  chatId: string,
  content: string,
  attachments: Attachment[],
  mentions: FileMention[],
  conversation: string | undefined
): Promise<Chat> {
  const question = stripBtwPrefix(promptForMentions(content, mentions))
  if (!question && attachments.length === 0) throw new Error('Message is empty')
  if (conversationEnded(conversation)) return getChat(chatId)

  const messageId = id()
  const started = await mutateChat(chatId, (chat) => {
    chat.messages.push({
      id: messageId,
      role: 'user',
      content: question || 'Screenshot',
      kind: 'steer',
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
      createdAt: now()
    })
  })
  // The conversation can end while the message is saved.
  if (conversationEnded(conversation)) return (await removeMessages(chatId, new Set([messageId]))) ?? started
  emitLive({ type: 'chat', chatId, chat: started })
  emitNotice({
    chatId,
    chatTitle: started.title,
    title: 'Steer',
    detail: question || 'Screenshot'
  })
  queueAsideSteer(chatId, { text: question, attachments, messageId, conversation })
  drainAsideSteers(chatId)
  return started
}

export async function startAside(
  chatId: string,
  project: Project | undefined,
  content: string,
  attachments: Attachment[] = [],
  mentions: FileMention[] = [],
  conversation?: string
): Promise<Chat> {
  if (!content.trim().startsWith(BTW_PREFIX)) {
    return startSteer(chatId, content, attachments, mentions, conversation)
  }
  const question = stripBtwPrefix(promptForMentions(content, mentions))
  if (!question && attachments.length === 0) throw new Error('Message is empty')

  const replyId = id()
  const started = await mutateChat(chatId, (chat) => {
    chat.messages.push({
      id: id(),
      role: 'user',
      content: question || 'Screenshot',
      kind: 'btw',
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
      createdAt: now()
    })
    chat.messages.push({
      id: replyId,
      role: 'assistant',
      content: '',
      kind: 'btw',
      createdAt: now()
    })
  })
  emitLive({ type: 'chat', chatId, chat: started })
  void runAside(started, project, replyId, question, attachments, conversation)
  return started
}

async function runAside(
  started: Chat,
  project: Project | undefined,
  replyId: string,
  question: string,
  attachments: Attachment[],
  conversation: string | undefined
): Promise<void> {
  const chatId = started.id
  const agent = normalizeChatAgent(started.agent)
  // Registered before the first await, so a stop in the meantime still reaches it.
  const abort = new AbortController()
  const group = asideAborts.get(chatId) ?? new Set<AbortController>()
  group.add(abort)
  asideAborts.set(chatId, group)
  const release = (): void => {
    group.delete(abort)
    if (group.size === 0 && asideAborts.get(chatId) === group) asideAborts.delete(chatId)
  }
  const signInError = await agentSignInError(agent).catch((error: unknown) => errorMessage(error))
  if (signInError || abort.signal.aborted) {
    release()
    const failed = await mutateChat(chatId, (chat) => {
      const reply = chat.messages.find((message) => message.id === replyId)
      if (reply) reply.content = signInError || '(stopped)'
    }).catch(() => null)
    if (failed) emitLive({ type: 'aside-done', chatId, chat: failed })
    return
  }

  emitNotice({
    chatId,
    chatTitle: started.title,
    title: 'Aside',
    detail: question || 'Screenshot'
  })

  const cwd = chatWorkingDir(started, project?.path) || homedir()
  let assembled = ''
  let steer = false
  try {
    const latest = await getChat(chatId).catch(() => started)
    assembled = await promptIsolated(
      cwd,
      asidePrompt(question, asideContext(latest, replyId)),
      attachments,
      emitAsideDelta(chatId, replyId),
      abort.signal,
      { agent, timeoutMs: ASIDE_TIMEOUT_MS }
    )
    const parsed = parseAsideReply(assembled)
    steer = parsed.steer
    const done = await mutateChat(chatId, (chat) => {
      const reply = chat.messages.find((message) => message.id === replyId)
      if (reply) reply.content = parsed.reply || '(empty response)'
    })
    emitLive({ type: 'aside-done', chatId, chat: done })
  } catch (error) {
    const message =
      assembled.trim() ||
      (error instanceof Error && /cancel/i.test(error.message) ? '(stopped)' : errorMessage(error))
    const parsed = assembled.trim() ? parseAsideReply(assembled) : { steer: false, reply: message }
    steer = parsed.steer && parsed.reply !== '(stopped)'
    const done = await mutateChat(chatId, (chat) => {
      const reply = chat.messages.find((item) => item.id === replyId)
      if (reply) reply.content = parsed.reply
    }).catch(() => null)
    if (done) emitLive({ type: 'aside-done', chatId, chat: done })
  } finally {
    release()
  }
  if (steer && question.trim() && !abort.signal.aborted && !conversationEnded(conversation)) {
    // The side question stays in the chat with its answer.
    queueAsideSteer(chatId, { text: question, attachments, conversation })
    drainAsideSteers(chatId)
  }
}

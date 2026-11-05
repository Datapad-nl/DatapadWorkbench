import { homedir } from 'os'
import type {
  AgentCommand,
  Attachment,
  Chat,
  ChatAgent,
  ChatEvent,
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
  agentForSession,
  bindExitPlanSession,
  cancelSession,
  contentText,
  ensureAgent,
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
import { emitGoal, emitNotice, finishTurn, startTurn } from './activity'
import { getClaudeCliInfo } from './claudeCli'
import { finishCheckpoint, snapshotTouched, startCheckpoint, rewindTo } from './checkpoints'
import { id, now, titleFromPrompt } from './ids'
import {
  bindPermissionSession,
  cancelChatPermissions,
  cancelSessionPermissions,
  resolveChatPlanApproval,
  setSessionMode
} from './permissions'
import { cancelChatQuestions, cancelSessionQuestions } from './questions'
import { clearGrokPlanApproval, grokBuildSignedIn, readGrokPlan } from './sessions'
import { chatWorkingDir, isolateChatIfNeeded } from './git'
import { projectSessionRules } from './intake'
import { getApiKey, getChat, listChats, mutateChat, saveChat } from './store'

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
}

type FollowUp = {
  text: string
  attachments?: Attachment[]
}

const inflight = new Map<string, { sessionId: string; gen: number }>()
const cancelled = new Set<string>()
const asideAborts = new Map<string, Set<AbortController>>()
const asideSteers = new Map<string, SteerNote[]>()
let nextGen = 1
const drafts = new Map<string, string>()
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
  const pending = hasPendingExitPlan(chatId)
  if (!text.trim() && entries.length === 0 && !pending) return
  const title =
    (live?.title && live.title !== 'Plan' && live.title !== 'No plan written yet' ? live.title : null) ||
    (disk?.title && disk.title !== 'No plan written yet' ? disk.title : null) ||
    (text.trim() ? text.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan' : 'Waiting for approval')
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
          const chat = await getChat(chatId)
          if (normalizePermissionMode(chat.mode) === 'plan') return
          chat.mode = 'plan'
          await saveChat(chat)
          if (chat.grokSessionId) {
            setSessionMode(chat.grokSessionId, 'plan')
            bindPermissionSession(chat.grokSessionId, chat.id, 'plan')
          }
          emitLive({ type: 'chat', chatId, chat })
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
    return
  }
  if (event.update.sessionUpdate !== 'agent_message_chunk') return
  const text = contentText(event.update.content)
  if (!text) return
  const current = drafts.get(event.sessionId) ?? ''
  drafts.set(event.sessionId, current + text)
  deltaListeners.get(event.sessionId)?.(text)
})

const deltaListeners = new Map<string, (text: string) => void>()

/** The slash commands the chat's agent announced for its current session. */
export async function chatCommands(chatId: string): Promise<AgentCommand[]> {
  const chat = await getChat(chatId)
  if (normalizeChatAgent(chat.agent) === 'grok') return grokCommands(chat.grokSessionId ?? null)
  return chat.grokSessionId ? sessionCommands(chat.grokSessionId) : []
}

export function isStreaming(chatId: string): boolean {
  return inflight.has(chatId)
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
  const current = inflight.get(chatId)
  cancelled.add(chatId)
  cancelAsides(chatId)
  cancelChatPermissions(chatId)
  cancelChatQuestions(chatId)
  resolveExitPlan(chatId, 'abandoned')
  if (!current) return false
  cancelSessionPermissions(current.sessionId)
  cancelSessionQuestions(current.sessionId)
  cancelSession(current.sessionId)
  const gen = current.gen
  setTimeout(() => {
    if (inflight.get(chatId)?.gen === gen) abortAgent(agentForSession(current.sessionId))
  }, 800)
  return true
}

function isCurrentTurn(chatId: string, gen: number): boolean {
  return inflight.get(chatId)?.gen === gen
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

const LONG_TASK_RE =
  /\b(implement|fix|add|create|write|edit|refactor|rename|delete|remove|migrate|update the|patch|wire|replace|extract|introduce|scaffold|build out|change the|extend|rerun|re-run|sweep|investigate|compare|measure|analyze|analyse|backtest|debug)\b/i

/** Long work goes through Grok's /goal loop so it keeps running and reports milestones. */
export function shouldStartGoal(mode: PermissionMode, text: string): boolean {
  if (mode !== 'accept') return false
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('/')) return false
  if (LONG_TASK_RE.test(trimmed)) return true
  return trimmed.length >= 280
}

function goalObjective(text: string): string {
  const line = text.trim().split('\n').find((item) => item.trim())?.trim() ?? 'this task'
  return line.length > 140 ? `${line.slice(0, 139).trim()}…` : line
}

export async function rewindChat(chatId: string, checkpointId: string, cwd: string | null): Promise<Chat> {
  if (isStreaming(chatId)) stopStream(chatId)
  const chat = await rewindTo(chatId, checkpointId, cwd)
  livePlans.delete(chatId)
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

export async function setChatMode(chatId: string, mode: PermissionMode): Promise<Chat> {
  const chat = await getChat(chatId)
  const next = normalizePermissionMode(mode)
  attachSession(chat, { silent: next !== 'plan' })
  if (next !== 'plan') {
    queueExitPlanVerdict(chatId, 'abandoned')
    resolveExitPlan(chatId, 'abandoned')
    resolveChatPlanApproval(chatId, 'deny')
  }
  chat.mode = next
  if (chat.plan?.awaitingApproval && next !== 'plan') {
    chat.plan = planHasBody(chat.plan)
      ? { ...chat.plan, awaitingApproval: false }
      : null
    if (chat.plan) livePlans.set(chat.id, chat.plan)
    else livePlans.delete(chat.id)
  }
  if (chat.grokSessionId) {
    setSessionMode(chat.grokSessionId, chat.mode)
    bindPermissionSession(chat.grokSessionId, chat.id, chat.mode)
    if (next !== 'plan') clearGrokPlanApproval(chat.grokSessionId)
    await applyAcpMode(chat.grokSessionId, chat.mode)
  }
  const saved = await saveChat(chat)
  emitLive({ type: 'chat', chatId, chat: saved })
  return saved
}

export async function settleChatPlan(chatId: string, verdict: PlanVerdict): Promise<boolean> {
  const outcome =
    verdict === 'approve' ? 'approved' : verdict === 'revise' ? 'cancelled' : 'abandoned'
  const liveTurn = inflight.has(chatId)
  const chat = await getChat(chatId)

  attachSession(chat, { silent: true })
  queueExitPlanVerdict(chatId, outcome)
  const continued = resolveExitPlan(chatId, outcome)
  if (verdict === 'approve') resolveChatPlanApproval(chatId, 'allow')
  if (verdict === 'abandon') resolveChatPlanApproval(chatId, 'deny')

  if (verdict === 'revise') {
    chat.mode = 'plan'
  } else {
    chat.mode = 'accept'
  }
  if (chat.plan) {
    const keepBody = verdict !== 'abandon' && planHasBody(chat.plan)
    chat.plan = keepBody ? { ...chat.plan, awaitingApproval: false } : null
    if (chat.plan) livePlans.set(chat.id, chat.plan)
    else livePlans.delete(chat.id)
  }
  if (chat.grokSessionId) {
    setSessionMode(chat.grokSessionId, chat.mode)
    bindPermissionSession(chat.grokSessionId, chat.id, chat.mode)
    if (verdict !== 'revise') clearGrokPlanApproval(chat.grokSessionId)
    await applyAcpMode(chat.grokSessionId, chat.mode)
  }
  const saved = await saveChat(chat)
  emitLive({ type: 'chat', chatId, chat: saved })
  return continued && liveTurn
}

export async function loadChat(chatId: string): Promise<Chat> {
  const chat = await getChat(chatId)
  attachSession(chat)
  if (chat.plan?.awaitingApproval && !hasPendingExitPlan(chat.id) && !planHasBody(chat.plan)) {
    chat.plan = null
    livePlans.delete(chat.id)
    if (chat.grokSessionId) clearGrokPlanApproval(chat.grokSessionId)
    const saved = await saveChat(chat)
    emitLive({ type: 'chat', chatId, chat: saved })
    return saved
  }
  return applyDiskPlan(chat)
}

async function resolveSession(chat: Chat, project: Project | undefined): Promise<{ chat: Chat; sessionId: string }> {
  const cwd = chatWorkingDir(chat, project?.path) || homedir()
  if (chat.grokSessionId && hasLiveSession(chat.grokSessionId)) {
    const sessionId = chat.grokSessionId
    const withPlan = applyDiskPlan(chat)
    if (withPlan.plan && withPlan.plan !== chat.plan) {
      chat = await saveChat(withPlan)
    }
    sessionChats.set(sessionId, chat.id)
    bindPermissionSession(sessionId, chat.id, normalizePermissionMode(chat.mode))
    bindExitPlanSession(sessionId, chat.id)
    return { chat, sessionId }
  }
  if (chat.grokSessionId) {
    const sessionId = chat.grokSessionId
    const withPlan = applyDiskPlan(chat)
    if (withPlan.plan && withPlan.plan !== chat.plan) {
      chat = await saveChat(withPlan)
    }
    sessionChats.set(sessionId, chat.id)
    bindPermissionSession(sessionId, chat.id, normalizePermissionMode(chat.mode))
    bindExitPlanSession(sessionId, chat.id)
    try {
      await loadSession(sessionId, cwd, await projectSessionRules(project?.id), normalizeChatAgent(chat.agent))
      return { chat, sessionId }
    } catch {
      // Session is gone in this agent process. Prompting the dead id returns
      // an empty turn, so open a replacement session instead.
    }
  }
  const sessionId = await newSession(
    cwd,
    await projectSessionRules(project?.id),
    normalizeChatAgent(chat.agent)
  )
  chat.grokSessionId = sessionId
  const saved = await saveChat(chat)
  sessionChats.set(sessionId, saved.id)
  bindPermissionSession(sessionId, saved.id, normalizePermissionMode(saved.mode))
  bindExitPlanSession(sessionId, saved.id)
  return { chat: saved, sessionId }
}

export async function appendUserMessage(
  chatId: string,
  content: string,
  attachments: Attachment[] = [],
  mentions: FileMention[] = []
): Promise<Chat> {
  if (inflight.has(chatId)) {
    throw new Error('This chat is already generating')
  }
  const trimmed = content.trim()
  if (!trimmed && attachments.length === 0 && mentions.length === 0) throw new Error('Message is empty')

  const chat = await getChat(chatId)
  chat.messages.push({
    id: id(),
    role: 'user',
    content: trimmed,
    attachments: attachments.length > 0 ? attachments : undefined,
    mentions: mentions.length > 0 ? mentions : undefined,
    createdAt: now()
  })
  if (chat.title === 'New chat') {
    chat.title = trimmed
      ? titleFromPrompt(trimmed)
      : mentions[0]?.path ?? (attachments.length > 0 ? 'Screenshot' : 'New chat')
  }
  return saveChat(chat)
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

export async function streamAssistant(
  chat: Chat,
  project: Project | undefined,
  onDelta: (text: string) => void,
  followUp?: FollowUp
): Promise<Chat | null> {
  if (inflight.has(chat.id)) {
    throw new Error('This chat is already generating')
  }
  const agent = normalizeChatAgent(chat.agent)
  const signInError = await agentSignInError(agent)
  if (signInError) throw new Error(signInError)

  await ensureAgent(agent)
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
    const siblings = (await listChats()).filter(
      (item) => item.projectId === chat.projectId && item.id !== chat.id
    )
    const isolated = await isolateChatIfNeeded(chat, project.path, lastUser!.content, {
      streaming: siblings.some((item) => isStreaming(item.id)),
      worktrees: siblings.filter((item) => item.worktreePath).length,
      chats: siblings.length
    })
    if (isolated.reason) {
      chat = await saveChat(isolated.chat)
      emitLive({ type: 'chat', chatId: chat.id, chat })
      emitNotice({
        chatId: chat.id,
        chatTitle: chat.title,
        title: 'Isolated worktree',
        detail: `${isolated.reason}\n${chat.worktreeBranch ?? ''}`
      })
    }
  }
  const resolved = await resolveSession(chat, project)

  const gen = nextGen++
  cancelled.delete(chat.id)
  inflight.set(chat.id, { sessionId: resolved.sessionId, gen })
  sessionChats.set(resolved.sessionId, chat.id)
  bindPermissionSession(
    resolved.sessionId,
    chat.id,
    normalizePermissionMode(resolved.chat.mode)
  )
  drafts.set(resolved.sessionId, '')
  deltaListeners.set(resolved.sessionId, onDelta)
  const opening = followText || lastUser?.content || 'Screenshot'
  startTurn({
    chatId: resolved.chat.id,
    chatTitle: resolved.chat.title,
    sessionId: resolved.sessionId,
    prompt: opening
  })

  try {
    await startCheckpoint({
      chat: resolved.chat,
      messageId: lastUser?.id ?? id(),
      label: opening,
      cwd: chatWorkingDir(resolved.chat, project?.path)
    })
    const withPoint = await getChat(chat.id)
    emitLive({ type: 'chat', chatId: chat.id, chat: withPoint })
  } catch {
    // turn still runs if checkpoint fails
  }

  const saveAssistant = (assembled: string): Promise<Chat> =>
    mutateChat(chat.id, (latest) => {
      const plan = livePlans.get(latest.id)
      if (plan) latest.plan = plan
      latest.grokSessionId = resolved.sessionId
      latest.messages.push({
        id: id(),
        role: 'assistant',
        content: assembled,
        createdAt: now()
      })
    })

  try {
    const mode = normalizePermissionMode(resolved.chat.mode)
    await applyAcpMode(resolved.sessionId, mode)
    const userText = followText || lastUser!.content
    const mentioned = followText ? followText : promptForMentions(lastUser!.content, lastUser!.mentions)
    const cued = promptForMode(mode, mentioned)
    const asGoal = !followText && shouldStartGoal(mode, userText)
    if (asGoal) {
      emitGoal({
        chatId: resolved.chat.id,
        chatTitle: resolved.chat.title,
        sessionId: resolved.sessionId,
        title: goalObjective(userText),
        detail: 'Running as a goal until this is done.'
      })
    }
    await promptSession(
      resolved.sessionId,
      asGoal ? `/goal ${cued}` : cued,
      followUp ? (followUp.attachments ?? []) : (lastUser!.attachments ?? [])
    )
    if (!isCurrentTurn(chat.id, gen)) return null
    // Commands like /compact finish without writing anything.
    const assembled =
      drafts.get(resolved.sessionId)?.trim() ||
      (isSlashCommand(userText) ? `Ran ${userText.trim().split(/\s/)[0]}` : '(empty response)')
    const saved = await saveAssistant(assembled)
    finishTurn(chat.id, 'done')
    return saved
  } catch (error) {
    const stopped = cancelled.has(chat.id) || (error instanceof Error && /cancel/i.test(error.message))
    if (!isCurrentTurn(chat.id, gen) && !stopped) return null
    const assembled = drafts.get(resolved.sessionId)?.trim()
    if (assembled) {
      const saved = await saveAssistant(assembled)
      finishTurn(chat.id, 'done')
      return saved
    }
    if (stopped) {
      const saved = await mutateChat(chat.id, (latest) => {
        latest.messages.push({
          id: id(),
          role: 'assistant',
          content: '(stopped)',
          createdAt: now()
        })
      })
      finishTurn(chat.id, 'done')
      return saved
    }
    finishTurn(chat.id, 'error', errorMessage(error))
    throw error
  } finally {
    void finishCheckpoint(chat.id)
    if (isCurrentTurn(chat.id, gen) || cancelled.has(chat.id)) inflight.delete(chat.id)
    cancelled.delete(chat.id)
    drafts.delete(resolved.sessionId)
    deltaListeners.delete(resolved.sessionId)
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
  list.push({ text, attachments: note.attachments })
  asideSteers.set(chatId, list)
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
    'The user sent this while you were working. Apply it to the current task. Do not restart from scratch unless they asked you to.',
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
    lines.push(`${who}${tag}: ${clipText(message.content, ASIDE_MESSAGE_MAX)}`)
  }
  const liveSession = inflight.get(chat.id)?.sessionId ?? chat.grokSessionId
  const live = liveSession ? drafts.get(liveSession)?.trim() : ''
  if (live) {
    lines.push(`${chatAgentLabel(normalizeChatAgent(chat.agent))} (in progress): ${clipText(live, 3_000)}`)
  }
  else if (!inflight.has(chat.id)) lines.push('The main task is not currently running.')
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

export function drainAsideSteers(chatId: string, project: Project | undefined): void {
  if (isStreaming(chatId)) return
  const notes = takeAsideSteers(chatId)
  if (notes.length === 0) return
  void getChat(chatId)
    .then((latest) =>
      streamAssistant(
        latest,
        project,
        (text) => {
          emitLive({ type: 'delta', chatId, text })
        },
        { text: steerPrompt(notes), attachments: notes.flatMap((note) => note.attachments) }
      )
    )
    .then((done) => {
      if (done) emitLive({ type: 'done', chatId, chat: done })
      drainAsideSteers(chatId, project)
    })
    .catch((error: unknown) => {
      if (/already generating/i.test(errorMessage(error))) {
        for (const note of notes) queueAsideSteer(chatId, note)
        return
      }
      emitLive({ type: 'error', chatId, error: errorMessage(error) })
    })
}

async function startSteer(
  chatId: string,
  project: Project | undefined,
  content: string,
  attachments: Attachment[],
  mentions: FileMention[]
): Promise<Chat> {
  const question = stripBtwPrefix(promptForMentions(content, mentions))
  if (!question && attachments.length === 0) throw new Error('Message is empty')

  const started = await mutateChat(chatId, (chat) => {
    chat.messages.push({
      id: id(),
      role: 'user',
      content: question || 'Screenshot',
      kind: 'steer',
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
      createdAt: now()
    })
  })
  emitLive({ type: 'chat', chatId, chat: started })
  emitNotice({
    chatId,
    chatTitle: started.title,
    title: 'Steer',
    detail: question || 'Screenshot'
  })
  queueAsideSteer(chatId, { text: question, attachments })
  drainAsideSteers(chatId, project)
  return started
}

export async function startAside(
  chatId: string,
  project: Project | undefined,
  content: string,
  attachments: Attachment[] = [],
  mentions: FileMention[] = []
): Promise<Chat> {
  if (!content.trim().startsWith(BTW_PREFIX)) {
    return startSteer(chatId, project, content, attachments, mentions)
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
  void runAside(started, project, replyId, question, attachments)
  return started
}

async function runAside(
  started: Chat,
  project: Project | undefined,
  replyId: string,
  question: string,
  attachments: Attachment[]
): Promise<void> {
  const chatId = started.id
  const agent = normalizeChatAgent(started.agent)
  const signInError = await agentSignInError(agent)
  if (signInError) {
    const failed = await mutateChat(chatId, (chat) => {
      const reply = chat.messages.find((message) => message.id === replyId)
      if (reply) reply.content = signInError
    })
    emitLive({ type: 'aside-done', chatId, chat: failed })
    return
  }

  emitNotice({
    chatId,
    chatTitle: started.title,
    title: 'Aside',
    detail: question || 'Screenshot'
  })

  const cwd = chatWorkingDir(started, project?.path) || homedir()
  const abort = new AbortController()
  const group = asideAborts.get(chatId) ?? new Set<AbortController>()
  group.add(abort)
  asideAborts.set(chatId, group)
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
      { agent }
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
    })
    emitLive({ type: 'aside-done', chatId, chat: done })
  } finally {
    group.delete(abort)
    if (group.size === 0) asideAborts.delete(chatId)
  }
  if (steer && question.trim() && !abort.signal.aborted && !cancelled.has(chatId)) {
    queueAsideSteer(chatId, { text: question, attachments })
    drainAsideSteers(chatId, project)
  }
}

import { randomUUID } from 'crypto'
import type { Chat } from '../shared/types'
import { callerChat, chatRunning, expectFollowUp, send } from './chatTools'
import { askUserQuestions, resolveUserQuestion } from './questions'
import { secretNameError, secretScope, setSecret } from './secrets'
import { getChat } from './store'

/** Secret requests by id, until the agent's tool call collects the result. */
const asks = new Map<string, Promise<{ text: string }>>()

type Continuation = {
  names: Set<string>
  savedAt: string
  /** The reply of the turn that continues the chat; undefined when none was sent. */
  settle: (reply: Chat | null | undefined) => void
}
/** Chats waiting for their turn to end, with the secrets saved in it, to continue with them set. */
const continuing = new Map<string, Continuation>()

const IDLE_POLL_MS = 1_000
const IDLE_WAIT_MS = 30 * 60_000

/**
 * Once the chat's turn has ended, a message continues it; its session then loads again with the secrets set.
 * Not when the user stopped the chat, or wrote to it since: their turn already had the secrets.
 */
function continueAfterTurn(chatId: string, name: string): void {
  const existing = continuing.get(chatId)
  if (existing) {
    existing.names.add(name)
    return
  }
  let settle: Continuation['settle'] = () => {}
  const reply = new Promise<Chat | null | undefined>((resolve) => (settle = resolve))
  const item: Continuation = { names: new Set([name]), savedAt: new Date().toISOString(), settle }
  continuing.set(chatId, item)
  // A delegated run answers its caller with this turn's reply, not with the one that asked for the secret.
  expectFollowUp(chatId, reply)
  const started = Date.now()
  const tick = async (): Promise<void> => {
    if (continuing.get(chatId) !== item) return
    if (chatRunning(chatId) && Date.now() - started < IDLE_WAIT_MS) {
      setTimeout(() => void tick(), IDLE_POLL_MS)
      return
    }
    continuing.delete(chatId)
    const chat = await getChat(chatId).catch(() => null)
    const wroteSince = chat?.messages.some((message) => message.role === 'user' && message.createdAt > item.savedAt)
    if (!chat || wroteSince || chatRunning(chatId)) {
      settle(undefined)
      return
    }
    const names = [...item.names]
    const list = names.map((saved) => `$${saved}`).join(', ')
    send(chatId, `${list} ${names.length === 1 ? 'is' : 'are'} now set in your shell. Continue with the task.`)
      .then((turn) => turn.done)
      .then(settle, () => settle(undefined))
  }
  setTimeout(() => void tick(), IDLE_POLL_MS)
}

/** The user stopped the chat: it does not go on by itself after a secret was saved. */
export function cancelContinuation(chatId: string): void {
  const item = continuing.get(chatId)
  if (!item) return
  continuing.delete(chatId)
  item.settle(undefined)
}

/**
 * The `request_secret` tool: the chat asks the user for a secret in a password field. The value goes to the
 * vault and is never returned; the agent gets the name only.
 */
export async function requestSecret(body: Record<string, unknown>): Promise<{ requestId: string }> {
  const chat = await callerChat(body.from)
  const scope = secretScope(chat)
  if (!scope) throw new Error('This chat has no project to keep a secret for.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const nameError = name ? secretNameError(name) : 'Pass name as an environment variable name, such as STRIPE_API_KEY.'
  if (nameError) throw new Error(nameError)
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : `Enter ${name}.`
  const requestId = randomUUID()
  const ask = askUserQuestions(
    requestId,
    `secret:${chat.id}`,
    [{ question: reason, header: name, multiSelect: false, options: [], secret: { name } }],
    'ext',
    { chatId: chat.id, title: 'A secret for this project' }
  )
    .then(async (outcome) => {
      const value = outcome.type === 'Accepted' ? String(outcome.partial_answers[0] ?? '') : ''
      if (!value) return { text: `The user did not give ${name}. Do not ask for it in the chat.` }
      await setSecret(scope, name, value)
      continueAfterTurn(chat.id, name)
      return {
        text: [
          `Saved ${name} for this project. Its value was not shared with you.`,
          `$${name} is set in your shell from the next turn, not in this one.`,
          'End this turn now with one short sentence. Datapad Workbench continues this chat once the turn has ended.'
        ].join(' ')
      }
    })
    .catch((error) => ({ text: `${name} was not saved: ${error instanceof Error ? error.message : String(error)}` }))
  asks.set(requestId, ask)
  return { requestId }
}

/** Waits up to `ms` for the user's answer. `done` with the result once there is one. */
export async function waitForSecret(body: Record<string, unknown>): Promise<{ done: boolean; text?: string }> {
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  const ask = asks.get(requestId)
  if (!ask) throw new Error('No such secret request.')
  const ms = typeof body.ms === 'number' && body.ms > 0 ? Math.min(body.ms, 120_000) : 60_000
  let timer: NodeJS.Timeout | undefined
  const result = await Promise.race([
    ask,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
  ])
  clearTimeout(timer)
  if (!result) return { done: false }
  asks.delete(requestId)
  return { done: true, text: result.text }
}

/** The agent's tool call was cancelled: the card closes and nothing is saved. */
export function cancelSecret(body: Record<string, unknown>): { ok: true } {
  const requestId = typeof body.requestId === 'string' ? body.requestId : ''
  asks.delete(requestId)
  resolveUserQuestion(requestId, { type: 'skip' })
  return { ok: true }
}

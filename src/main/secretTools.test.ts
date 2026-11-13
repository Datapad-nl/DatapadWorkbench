import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserQuestionRequest } from '../shared/types'

const fake = vi.hoisted(() => ({
  saved: [] as Array<[string, string, string]>,
  sent: [] as Array<[string, string]>,
  followUps: [] as Array<[string, Promise<unknown>]>,
  running: false,
  messages: [] as Array<{ role: string; createdAt: string }>
}))

vi.mock('./chatTools', () => ({
  callerChat: async (from: unknown) => ({ id: String(from), projectId: from === 'loose' ? '' : 'p1' }),
  chatRunning: () => fake.running,
  expectFollowUp: (chatId: string, reply: Promise<unknown>) => fake.followUps.push([chatId, reply]),
  send: async (chatId: string, content: string) => {
    fake.sent.push([chatId, content])
    return { done: Promise.resolve({ id: chatId, reply: 'continued' }) }
  }
}))
vi.mock('./store', () => ({
  getChat: async (chatId: string) => ({ id: chatId, messages: fake.messages })
}))
vi.mock('./secrets', () => ({
  secretNameError: (name: string) =>
    /^[A-Za-z_]\w*$/.test(name) ? (name.startsWith('ANTHROPIC_') ? `${name} is used by the agent itself` : null) : 'bad',
  secretScope: (chat: { projectId: string }) => chat.projectId || null,
  setSecret: async (scope: string, name: string, value: string) => {
    fake.saved.push([scope, name, value])
  }
}))

import { onUserQuestionPrompt, resolveUserQuestion } from './questions'
import { cancelContinuation, cancelSecret, requestSecret, waitForSecret } from './secretTools'

afterEach(() => {
  fake.saved.length = 0
  fake.sent.length = 0
  fake.followUps.length = 0
  fake.messages = []
  fake.running = false
  vi.useRealTimers()
})

function nextPrompt(): Promise<UserQuestionRequest> {
  return new Promise((resolve) => {
    const off = onUserQuestionPrompt((request) => {
      off()
      resolve(request)
    })
  })
}

/** Asks for a secret in the chat and types the value into the card. */
async function saveSecret(chatId: string, name: string, value: string): Promise<string | undefined> {
  const prompted = nextPrompt()
  const { requestId } = await requestSecret({ from: chatId, name })
  resolveUserQuestion((await prompted).requestId, { type: 'submit', answers: [[value]] })
  return (await waitForSecret({ requestId, ms: 1_000 })).text
}

describe('request_secret', () => {
  it('asks in a password field, saves the value and gives the agent the name only', async () => {
    vi.useFakeTimers()
    fake.running = true
    const prompted = nextPrompt()
    const { requestId } = await requestSecret({ from: 'chat-1', name: 'STRIPE_KEY', reason: 'For the checkout tests.' })
    const request = await prompted
    expect(request.chatId).toBe('chat-1')
    expect(request.questions).toEqual([
      { question: 'For the checkout tests.', header: 'STRIPE_KEY', multiSelect: false, options: [], secret: { name: 'STRIPE_KEY' } }
    ])

    resolveUserQuestion(request.requestId, { type: 'submit', answers: [['sk_live_123']] })
    const result = await waitForSecret({ requestId, ms: 1_000 })
    expect(result.done).toBe(true)
    expect(result.text).toContain('Saved STRIPE_KEY')
    expect(result.text).not.toContain('sk_live_123')
    expect(fake.saved).toEqual([['p1', 'STRIPE_KEY', 'sk_live_123']])

    // The chat continues by itself once its turn has ended, so its session loads with the secret set.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fake.sent).toEqual([])
    fake.running = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.sent).toEqual([['chat-1', '$STRIPE_KEY is now set in your shell. Continue with the task.']])
    // A delegated run answers with the reply of that turn.
    expect(fake.followUps.map(([chatId]) => chatId)).toEqual(['chat-1'])
    await expect(fake.followUps[0][1]).resolves.toEqual({ id: 'chat-1', reply: 'continued' })
  })

  it('does not continue a chat the user stopped', async () => {
    vi.useFakeTimers()
    fake.running = true
    await saveSecret('chat-5', 'TOKEN', 'x')
    cancelContinuation('chat-5')
    fake.running = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.sent).toEqual([])
    await expect(fake.followUps[0][1]).resolves.toBeUndefined()
  })

  it('does not continue a chat the user wrote to since: that turn had the secret', async () => {
    vi.useFakeTimers()
    fake.running = true
    await saveSecret('chat-6', 'TOKEN', 'x')
    fake.messages = [{ role: 'user', createdAt: new Date(Date.now() + 1_000).toISOString() }]
    fake.running = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.sent).toEqual([])
  })

  it('tells the agent when the user skipped, and saves nothing', async () => {
    const prompted = nextPrompt()
    const { requestId } = await requestSecret({ from: 'chat-2', name: 'TOKEN' })
    resolveUserQuestion((await prompted).requestId, { type: 'skip' })
    const result = await waitForSecret({ requestId })
    expect(result).toEqual({ done: true, text: 'The user did not give TOKEN. Do not ask for it in the chat.' })
    expect(fake.saved).toEqual([])
    expect(fake.sent).toEqual([])
  })

  it('reports a wait with no answer yet as not done, and closes the card when the tool call is cancelled', async () => {
    const prompted = nextPrompt()
    const { requestId } = await requestSecret({ from: 'chat-3', name: 'TOKEN' })
    expect(await waitForSecret({ requestId, ms: 10 })).toEqual({ done: false })
    await prompted
    cancelSecret({ requestId })
    expect(resolveUserQuestion(requestId, { type: 'submit', answers: [['late']] })).toBe(false)
    expect(fake.saved).toEqual([])
    await expect(waitForSecret({ requestId })).rejects.toThrow('No such secret request')
  })

  it('refuses a bad or reserved name, and a chat with no project or bot', async () => {
    await expect(requestSecret({ from: 'chat-4', name: 'my key' })).rejects.toThrow('bad')
    await expect(requestSecret({ from: 'chat-4', name: 'ANTHROPIC_API_KEY' })).rejects.toThrow('used by the agent')
    await expect(requestSecret({ from: 'loose', name: 'TOKEN' })).rejects.toThrow('no project')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../shared/types'

const stub = vi.hoisted(() => ({ chats: new Map<string, Chat>(), subagentModel: '' }))
vi.mock('./git', () => ({ addChatWorktree: vi.fn(), dropWorktreeIfUnchanged: vi.fn() }))
vi.mock('./store', () => ({
  createChat: vi.fn(),
  getChat: async (chatId: string) => structuredClone(stub.chats.get(chatId)!),
  getSubagentModel: async () => stub.subagentModel,
  listProjects: async () => [],
  listChats: async () => [...stub.chats.values()].map((chat) => ({ ...chat, messageCount: chat.messages.length })),
  mutateChat: async (chatId: string, change: (chat: Chat) => void) => {
    const chat = stub.chats.get(chatId)!
    change(chat)
    return structuredClone(chat)
  }
}))

import { delegateTask, nudgeWorker, registerChatTools, startScheduler, waitForDelegate } from './chatTools'
import { createChat } from './store'

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduled runs', () => {
  it('keeps a run that fails after it started in the chat, and moves the schedule on once', async () => {
    vi.useFakeTimers()
    const due = new Date(Date.now() - 60_000).toISOString()
    stub.chats.set('nightly', {
      id: 'nightly',
      title: 'Nightly',
      messages: [],
      schedule: { prompt: 'run the report', nextRunAt: due }
    } as unknown as Chat)
    const events: string[] = []
    let sends = 0
    registerChatTools({
      send: async () => {
        sends += 1
        // Started, then the agent fails (signed out) while the turn runs.
        return { chat: stub.chats.get('nightly')!, done: Promise.reject(new Error('Run `grok login` first.')) }
      },
      emit: (event) => events.push(event.type),
      isStreaming: () => false
    })

    startScheduler()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(30_000)

    const chat = stub.chats.get('nightly')!
    expect(sends).toBe(1)
    expect(chat.schedule).toBeNull()
    expect(chat.messages.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'The scheduled run failed: Run `grok login` first.']
    ])
    expect(events).toContain('chat')
  })
})

describe('workers', () => {
  function started(): { sent: Array<[string, string]> } {
    const sent: Array<[string, string]> = []
    registerChatTools({
      send: async (chatId, content) => {
        sent.push([chatId, content])
        const chat = stub.chats.get(chatId)!
        chat.messages.push({ id: 'reply', role: 'assistant', content: `did: ${content}`, createdAt: '' })
        return { chat, done: Promise.resolve(chat) }
      },
      emit: () => undefined,
      isStreaming: () => false
    })
    return { sent }
  }

  function chat(id: string, extra: Partial<Chat> = {}): void {
    stub.chats.set(id, { id, projectId: 'p', title: id, messages: [], ...extra } as unknown as Chat)
  }

  async function delegated(input: Record<string, unknown>): Promise<Parameters<typeof createChat>[1]> {
    vi.mocked(createChat).mockImplementationOnce(async (_projectId, made) => {
      chat('worker', made as Partial<Chat>)
      return stub.chats.get('worker')!
    })
    await delegateTask({ from: 'boss', brief: 'rename the flag', ...input })
    return vi.mocked(createChat).mock.lastCall![1]
  }

  it('runs a worker on the model the conductor picked, on Claude Code, as its child', async () => {
    started()
    chat('boss')
    stub.subagentModel = ''
    expect(await delegated({ model: 'haiku' })).toMatchObject({ agent: 'claude', model: 'haiku', parentChatId: 'boss' })
    expect(await waitForDelegate({ chatId: 'worker', ms: 1000 })).toMatchObject({ done: true, answer: 'did: rename the flag' })
  })

  it('lets the model in Settings win, and leaves a Grok worker without one', async () => {
    started()
    chat('boss')
    stub.subagentModel = 'opus'
    expect(await delegated({ model: 'haiku' })).toMatchObject({ agent: 'claude', model: 'opus' })
    expect(await delegated({ agent: 'grok' })).toMatchObject({ agent: 'grok', model: '' })
  })

  it('nudges only a worker of the calling chat', async () => {
    const { sent } = started()
    chat('boss')
    chat('worker', { parentChatId: 'boss' })
    chat('other')
    await nudgeWorker({ from: 'boss', chat: 'worker', message: 'the test still fails' })
    expect(sent).toEqual([['worker', 'the test still fails']])
    expect(await waitForDelegate({ chatId: 'worker', ms: 1000 })).toMatchObject({ answer: 'did: the test still fails' })
    await expect(nudgeWorker({ from: 'boss', chat: 'other', message: 'hi' })).rejects.toThrow('not a worker')
  })
})

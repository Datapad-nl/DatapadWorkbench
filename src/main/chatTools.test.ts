import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../shared/types'

const stub = vi.hoisted(() => ({ chats: new Map<string, Chat>() }))
vi.mock('./git', () => ({ addChatWorktree: vi.fn(), dropWorktreeIfUnchanged: vi.fn() }))
vi.mock('./store', () => ({
  createChat: vi.fn(),
  getChat: async (chatId: string) => structuredClone(stub.chats.get(chatId)!),
  listProjects: async () => [],
  listChats: async () => [...stub.chats.values()].map((chat) => ({ ...chat, messageCount: chat.messages.length })),
  mutateChat: async (chatId: string, change: (chat: Chat) => void) => {
    const chat = stub.chats.get(chatId)!
    change(chat)
    return structuredClone(chat)
  }
}))

import { registerChatTools, startScheduler } from './chatTools'

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

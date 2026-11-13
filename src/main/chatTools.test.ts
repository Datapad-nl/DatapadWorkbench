import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot, Chat, ChatEvent } from '../shared/types'

const stub = vi.hoisted(() => ({
  chats: new Map<string, Chat>(),
  subagentModel: '',
  maxSubagents: 4,
  handoffs: [] as string[],
  scout: { chatId: null as string | null, unread: 0 }
}))
vi.mock('./git', () => ({ addChatWorktree: vi.fn(), dropWorktreeIfUnchanged: vi.fn() }))
vi.mock('./bots', () => {
  const getBot = async (botId: string) => {
    if (botId !== 'scout') throw new Error('Bot not found')
    return { id: 'scout', name: 'Scout', agent: 'claude', model: '', folder: '/bots/scout', ...stub.scout }
  }
  return {
    getBot,
    setBotChat: async (botId: string, chatId: string) => {
      stub.scout.chatId = chatId
      return getBot(botId)
    },
    addBotUnread: async (botId: string) => {
      stub.scout.unread += 1
      return getBot(botId)
    },
    clearBotUnread: async (botId: string) => {
      stub.scout.unread = 0
      return getBot(botId)
    }
  }
})
vi.mock('./store', () => ({
  createChat: vi.fn(),
  getChat: async (chatId: string) => {
    const chat = stub.chats.get(chatId)
    if (!chat) throw new Error('Chat not found')
    return structuredClone(chat)
  },
  getMaxSubagents: async () => stub.maxSubagents,
  getSubagentModel: async () => stub.subagentModel,
  listProjects: async () => [],
  listChats: async () => [...stub.chats.values()].map((chat) => ({ ...chat, messageCount: chat.messages.length })),
  mutateChat: async (chatId: string, change: (chat: Chat) => void) => {
    const chat = stub.chats.get(chatId)!
    change(chat)
    return structuredClone(chat)
  },
  saveHandoff: async (chatId: string, markdown: string) => {
    stub.handoffs.push(markdown)
    return `/data/handoffs/${chatId}.md`
  }
}))

import {
  agentHook,
  askBot,
  botChat,
  delegateTask,
  handoffChat,
  markBotRead,
  newBotChat,
  nudgeWorker,
  registerChatTools,
  scheduleBotTask,
  startScheduler,
  waitForDelegate
} from './chatTools'
import type { BuiltinAgent } from '../shared/builtinAgents'
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

  it('refuses a worker past the limit in Settings, until one has reported back', async () => {
    let running = true
    registerChatTools({
      send: async (chatId) => ({ chat: stub.chats.get(chatId)!, done: Promise.resolve(stub.chats.get(chatId)!) }),
      emit: () => undefined,
      isStreaming: (chatId) => running && chatId !== 'boss'
    })
    chat('boss')
    chat('first', { parentChatId: 'boss' })
    chat('second', { parentChatId: 'boss' })
    chat('elsewhere', { parentChatId: 'other' })
    stub.subagentModel = ''
    stub.maxSubagents = 2
    await expect(delegated({})).rejects.toThrow('Settings allows 2 at the same time')
    running = false
    expect(await delegated({})).toMatchObject({ parentChatId: 'boss' })
    stub.maxSubagents = 4
  })

  describe("Claude Code's own agents", () => {
    const DENIED = { hookSpecificOutput: { permissionDecision: 'deny' } }
    let agents: BuiltinAgent[] = []
    const agent = (id: string, status: BuiltinAgent['status']): BuiltinAgent =>
      ({ id, status, background: false }) as BuiltinAgent

    function own(workerRunning = false): void {
      agents = []
      registerChatTools({
        send: async (chatId) => ({ chat: stub.chats.get(chatId)!, done: Promise.resolve(stub.chats.get(chatId)!) }),
        emit: () => undefined,
        isStreaming: (chatId) => workerRunning && chatId === 'first',
        builtinAgents: () => agents
      })
      stub.subagentModel = ''
      stub.maxSubagents = 2
    }

    afterEach(() => {
      stub.subagentModel = ''
      stub.maxSubagents = 4
    })

    it('refuses an Agent call past the limit in Settings, until an agent has ended', async () => {
      own()
      // The stream shows every call of the turn as running before any of them is asked about.
      agents = [agent('a1', 'running'), agent('a2', 'running'), agent('a3', 'running')]
      expect(await agentHook('solo', { tool_use_id: 'a1' })).toEqual({})
      expect(await agentHook('solo', { tool_use_id: 'a2' })).toEqual({})
      expect(await agentHook('solo', { tool_use_id: 'a3' })).toMatchObject({
        hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('Settings allows 2 at the same time') }
      })
      agents = [agent('a1', 'done'), agent('a2', 'running'), agent('a3', 'error')]
      expect(await agentHook('solo', { tool_use_id: 'a4' })).toEqual({})
      expect(await agentHook('solo', { tool_use_id: 'a5' })).toMatchObject(DENIED)
    })

    it('counts the workers of the chat too, and delegate counts the agents', async () => {
      own(true)
      chat('boss')
      chat('first', { parentChatId: 'boss' })
      expect(await agentHook('boss', { tool_use_id: 'b1' })).toEqual({})
      expect(await agentHook('boss', { tool_use_id: 'b2' })).toMatchObject(DENIED)
      await expect(delegated({})).rejects.toThrow('Settings allows 2 at the same time')
    })

    it('lets through a call made by an agent, which no list follows', async () => {
      own()
      stub.maxSubagents = 1
      expect(await agentHook('nested', { tool_use_id: 'n1' })).toEqual({})
      expect(await agentHook('nested', { tool_use_id: 'n2', agent_id: 'inner' })).toEqual({})
    })

    it("refuses a conductor's own file edits and lets its agents' and other chats' edits through", async () => {
      own()
      chat('boss', { conductor: true })
      chat('plain')
      const edit = { tool_name: 'Edit', tool_use_id: 'e1' }
      expect(await agentHook('boss', edit)).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('delegate') }
      })
      expect(await agentHook('boss', { ...edit, tool_name: 'Write' })).toMatchObject(DENIED)
      expect(await agentHook('boss', { ...edit, agent_id: 'inner' })).toEqual({})
      expect(await agentHook('plain', edit)).toEqual({})
      // An edit is not an agent, so it does not count toward the limit.
      stub.maxSubagents = 1
      expect(await agentHook('plain', { tool_name: 'Write', tool_use_id: 'e2' })).toEqual({})
      expect(await agentHook('plain', { tool_name: 'Agent', tool_use_id: 'a1' })).toEqual({})
    })

    it('drops the model a call asks for when Settings fixes one, and keeps it otherwise', async () => {
      own()
      const call = { tool_input: { prompt: 'rename the flag', model: 'opus' } }
      expect(await agentHook('picks', { tool_use_id: 'm1', ...call })).toEqual({})
      stub.subagentModel = 'claude-haiku-4-5'
      expect(await agentHook('picks', { tool_use_id: 'm2', ...call })).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { prompt: 'rename the flag' } }
      })
    })
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

describe('handoff', () => {
  const pr = { number: 7, url: 'https://github.com/o/r/pull/7', watch: true } as unknown as Chat['pr']

  function setup(): { sent: Array<[string, string]>; events: Chat[] } {
    const sent: Array<[string, string]> = []
    const events: Chat[] = []
    registerChatTools({
      send: async (chatId, content) => {
        sent.push([chatId, content])
        const chat = stub.chats.get(chatId)!
        return { chat, done: Promise.resolve(chat) }
      },
      emit: (event) => {
        if (event.type === 'chat') events.push(event.chat)
      },
      isStreaming: () => false
    })
    stub.chats.set('long', {
      id: 'long',
      projectId: 'p',
      title: 'Move the store',
      agent: 'claude',
      model: 'opus',
      mode: 'accept',
      worktreePath: '/wt/long',
      worktreeBranch: 'workbench/long',
      pr,
      messages: [{ id: 'm', role: 'user', content: 'go', createdAt: '' }]
    } as unknown as Chat)
    // Earlier cases may leave a queued implementation behind.
    vi.mocked(createChat).mockReset()
    vi.mocked(createChat).mockImplementationOnce(async (projectId, made) => {
      stub.chats.set('fresh', { id: 'fresh', projectId, title: 'New chat', messages: [], ...made } as unknown as Chat)
      return stub.chats.get('fresh')!
    })
    return { sent, events }
  }

  it('continues in a new chat that works where the old one did, and moves the PR along', async () => {
    const { sent, events } = setup()
    const result = await handoffChat({ from: 'long', summary: '## Goal\nSQLite store', next: 'run the migration' })

    expect(result).toEqual({ chatId: 'fresh', title: 'Move the store', file: '/data/handoffs/long.md' })
    expect(vi.mocked(createChat).mock.lastCall).toEqual(['p', { title: 'Move the store', agent: 'claude', model: 'opus' }])
    const fresh = stub.chats.get('fresh')!
    expect(fresh).toMatchObject({
      handoffFrom: 'long',
      mode: 'accept',
      worktreePath: '/wt/long',
      worktreeBranch: 'workbench/long',
      pr
    })
    expect(stub.chats.get('long')).toMatchObject({ handoffTo: 'fresh', pr: null })
    expect(events.map((chat) => chat.id)).toEqual(['long', 'fresh'])
    expect(stub.handoffs.at(-1)).toBe('# Handoff from "Move the store"\n\n## Goal\nSQLite store\n\n## Next\n\nrun the migration\n')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toBe('fresh')
    expect(sent[0][1]).toContain('## Goal\nSQLite store')
    expect(sent[0][1]).toContain('Start with this: run the migration')
  })

  it('refuses an empty handoff and leaves the chat as it was', async () => {
    setup()
    await expect(handoffChat({ from: 'long', summary: '  ' })).rejects.toThrow('summary is empty')
    expect(createChat).not.toHaveBeenCalled()
    expect(stub.chats.get('long')?.handoffTo).toBeUndefined()
  })

  it('waits for running subagents before handing off', async () => {
    setup()
    stub.chats.set('child', { id: 'child', projectId: 'p', parentChatId: 'long', messages: [] } as unknown as Chat)
    registerChatTools({
      send: async () => ({ chat: stub.chats.get('long')!, done: Promise.resolve(null) }),
      emit: () => undefined,
      isStreaming: (chatId) => chatId === 'child'
    })
    await expect(handoffChat({ from: 'long', summary: 'state' })).rejects.toThrow('Subagents of this chat are still running')
    stub.chats.delete('child')
  })
})

describe('bot schedules', () => {
  function made(): void {
    vi.mocked(createChat).mockImplementationOnce(async (projectId, input) => {
      const chat = { id: 'bot-run', projectId, title: '', messages: [], ...input } as unknown as Chat
      stub.chats.set(chat.id, chat)
      return structuredClone(chat)
    })
  }

  it("opens a chat of the bot, on the bot's agent, that runs on the schedule", async () => {
    made()
    const chat = await scheduleBotTask({ botId: 'scout', prompt: '  check the feeds\nand summarise ', cron: '0 9 * * 1-5' })
    expect(vi.mocked(createChat).mock.lastCall).toEqual([
      '',
      { botId: 'scout', title: 'Scheduled: check the feeds', agent: 'claude' }
    ])
    expect(chat.schedule).toMatchObject({ prompt: 'check the feeds\nand summarise', cron: '0 9 * * 1-5' })
    expect(Date.parse(chat.schedule!.nextRunAt!)).toBeGreaterThan(Date.now())
  })

  it('runs once at a time to come', async () => {
    made()
    const at = new Date(Date.now() + 3_600_000).toISOString()
    const chat = await scheduleBotTask({ botId: 'scout', prompt: 'remind me', at })
    expect(chat.schedule).toEqual({ prompt: 'remind me', cron: undefined, nextRunAt: at })
  })

  it('refuses a schedule it cannot run, before any chat is made', async () => {
    vi.mocked(createChat).mockClear()
    const past = new Date(Date.now() - 3_600_000).toISOString()
    await expect(scheduleBotTask({ botId: 'scout', prompt: '', cron: '0 9 * * *' })).rejects.toThrow('Write what')
    await expect(scheduleBotTask({ botId: 'scout', prompt: 'x' })).rejects.toThrow('either cron')
    await expect(scheduleBotTask({ botId: 'scout', prompt: 'x', at: past })).rejects.toThrow('in the past')
    await expect(scheduleBotTask({ botId: 'gone', prompt: 'x', cron: '0 9 * * *' })).rejects.toThrow('Bot not found')
    expect(createChat).not.toHaveBeenCalled()
  })
})

describe('@bot', () => {
  function asked(): Array<[string, string]> {
    const sent: Array<[string, string]> = []
    stub.chats.set('project-chat', {
      id: 'project-chat',
      projectId: 'p1',
      title: 'Auth',
      messages: [{ id: 'u1', role: 'user', content: 'review the login', createdAt: '' }]
    } as unknown as Chat)
    vi.mocked(createChat).mockReset()
    vi.mocked(createChat).mockImplementationOnce(async (projectId, input) => {
      const chat = { id: 'scout-run', projectId, title: '', messages: [], ...input } as unknown as Chat
      stub.chats.set(chat.id, chat)
      return structuredClone(chat)
    })
    registerChatTools({
      send: async (chatId, content) => {
        sent.push([chatId, content])
        const chat = stub.chats.get(chatId)!
        chat.messages.push({ id: 'a1', role: 'assistant', content: 'Looks fine.', createdAt: '' })
        return { chat, done: Promise.resolve(structuredClone(chat)) }
      },
      emit: () => {},
      isStreaming: () => false
    })
    return sent
  }

  it("runs the bot in the project's folder and posts its answer in the project chat", async () => {
    const sent = asked()
    await askBot({ botId: 'scout', fromChatId: 'project-chat', content: 'review the login' })

    expect(vi.mocked(createChat).mock.lastCall).toEqual([
      'p1',
      { botId: 'scout', agent: 'claude', title: 'Project: review the login' }
    ])
    expect(stub.chats.get('scout-run')!.replyTo).toBe('project-chat')
    expect(sent).toEqual([['scout-run', 'review the login']])
    expect(stub.chats.get('project-chat')!.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Looks fine.',
      fromBot: { botId: 'scout', name: 'Scout', runChatId: 'scout-run' }
    })
  })

  it('posts why the bot could not answer', async () => {
    asked()
    vi.mocked(createChat).mockReset()
    await askBot({ botId: 'gone', fromChatId: 'project-chat', content: 'hello' })
    expect(createChat).not.toHaveBeenCalled()
    expect(stub.chats.get('project-chat')!.messages.at(-1)).toMatchObject({
      content: 'Could not answer: Bot not found',
      fromBot: { botId: 'gone', runChatId: '' }
    })
  })
})

describe("the bot's chat", () => {
  function botChats(): ChatEvent[] {
    stub.chats.clear()
    stub.scout = { chatId: null, unread: 0 }
    vi.mocked(createChat).mockReset()
    let made = 0
    vi.mocked(createChat).mockImplementation(async (projectId, input) => {
      made += 1
      const chat = { id: `scout-chat-${made}`, projectId, messages: [], ...input } as unknown as Chat
      stub.chats.set(chat.id, chat)
      return structuredClone(chat)
    })
    const events: ChatEvent[] = []
    registerChatTools({
      send: async () => {
        throw new Error('not in this test')
      },
      emit: (event) => events.push(event),
      isStreaming: () => false
    })
    return events
  }

  it('is made once, kept on the bot, and made again once it was deleted', async () => {
    const events = botChats()
    const [first, again] = await Promise.all([botChat('scout'), botChat('scout')])
    expect(vi.mocked(createChat).mock.calls).toEqual([['', { botId: 'scout', agent: 'claude', title: 'Scout' }]])
    expect(again.id).toBe(first.id)
    expect(stub.scout.chatId).toBe(first.id)
    expect(events.map((event) => event.type)).toEqual(['chat', 'bot'])
    expect((await botChat('scout')).id).toBe(first.id)

    stub.chats.delete(first.id)
    const remade = await botChat('scout')
    expect(remade.id).not.toBe(first.id)
    expect(stub.scout.chatId).toBe(remade.id)
  })

  it("follows the bot's agent: a fresh chat switches, a started one is kept and a new chat made", async () => {
    const events = botChats()
    stub.chats.set('old', { id: 'old', projectId: '', agent: 'grok', messages: [], grokSessionId: null } as unknown as Chat)
    stub.scout.chatId = 'old'
    const switched = await botChat('scout')
    expect(switched).toMatchObject({ id: 'old', agent: 'claude' })
    expect(vi.mocked(createChat)).not.toHaveBeenCalled()
    expect(events.map((event) => event.type)).toEqual(['chat'])

    stub.chats.set('old', { ...stub.chats.get('old')!, agent: 'grok', grokSessionId: 's1' })
    const fresh = await botChat('scout')
    expect(fresh.id).not.toBe('old')
    expect(fresh.agent).toBe('claude')
    expect(stub.scout.chatId).toBe(fresh.id)
    expect(stub.chats.has('old')).toBe(true)
  })

  it('/new gives the bot a fresh chat and keeps the old one', async () => {
    botChats()
    const first = await botChat('scout')
    const next = await newBotChat('scout')
    expect(next.id).not.toBe(first.id)
    expect(stub.scout.chatId).toBe(next.id)
    expect(stub.chats.has(first.id)).toBe(true)
  })

  it('is marked read', async () => {
    const events = botChats()
    stub.scout.unread = 3
    expect((await markBotRead('scout')).unread).toBe(0)
    expect(events).toEqual([{ type: 'bot', bot: expect.objectContaining({ id: 'scout', unread: 0 }) }])
  })

  it("gets a scheduled run's answer, or why it failed, as a new message from the bot", async () => {
    botChats()
    vi.useFakeTimers()
    const due = new Date(Date.now() - 60_000).toISOString()
    const run = (id: string, title: string) =>
      ({ id, projectId: '', botId: 'scout', title, messages: [], schedule: { prompt: 'brief me', nextRunAt: due } }) as unknown as Chat
    stub.chats.set('brief', run('brief', 'Scheduled: Morning brief'))
    stub.chats.set('broken', run('broken', 'Scheduled: Backup'))
    // A fresh module, so its scheduler starts on these fake timers.
    vi.resetModules()
    const tools = await import('./chatTools')
    const events: ChatEvent[] = []
    const notified: Array<[Pick<Bot, 'id' | 'unread'>, string, string]> = []
    tools.registerChatTools({
      send: async (chatId) => {
        const chat = stub.chats.get(chatId)!
        if (chatId === 'broken') return { chat, done: Promise.reject(new Error('disk full')) }
        chat.messages.push({ id: 'a1', role: 'assistant', content: 'All quiet.\nNothing to do.', createdAt: '' })
        return { chat, done: Promise.resolve(structuredClone(chat)) }
      },
      emit: (event) => events.push(event),
      isStreaming: () => false,
      notifyBot: (bot, chatId, text) => notified.push([bot, chatId, text])
    })

    tools.startScheduler()
    await vi.advanceTimersByTimeAsync(5_000)

    const own = stub.chats.get(stub.scout.chatId!)!
    expect(own.messages.map((message) => [message.content, message.fromBot])).toEqual(
      expect.arrayContaining([
        ['All quiet.\nNothing to do.', { botId: 'scout', name: 'Scout', runChatId: 'brief' }],
        ['The scheduled run failed: disk full', { botId: 'scout', name: 'Scout', runChatId: 'broken' }]
      ])
    )
    expect(own.messages).toHaveLength(2)
    expect(own.messages.every((message) => message.role === 'assistant')).toBe(true)
    expect(stub.scout.unread).toBe(2)
    expect(vi.mocked(createChat)).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({
      type: 'bot-message',
      botId: 'scout',
      chatId: own.id,
      text: 'All quiet.\nNothing to do.',
      source: 'Morning brief'
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'bot-message', source: 'Backup' }))
    expect(notified.map(([, chatId]) => chatId)).toEqual([own.id, own.id])
    // The failure is still kept in the run's own chat.
    expect(stub.chats.get('broken')!.messages.at(-1)?.content).toBe('The scheduled run failed: disk full')
  })
})

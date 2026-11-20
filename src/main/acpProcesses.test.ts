import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Call = { method: string; params: Record<string, unknown> }
type FakeProc = EventEmitter & {
  args: string[]
  env: Record<string, string | undefined> | undefined
  calls: Call[]
  /** The answers the app sent to the agent's own requests. */
  replies: Array<{ id: unknown; result?: unknown }>
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: () => void
}

const fake = vi.hoisted(() => ({
  procs: [] as FakeProc[],
  sessions: 0,
  /** What Claude Code answers a steer: `injected` while a turn runs, `promptRequired` when idle. */
  steerOutcome: 'injected',
  /** The bot of each chat, by chat id. */
  bots: {} as Record<
    string,
    { id?: string; agent: string; model: string; effort: string; conciseReplies?: boolean; allowedTools?: string[]; mcpServers?: string[] }
  >,
  /** The MCP servers in Settings. */
  mcp: {} as Record<string, unknown>,
  /** Chats made conductor with /conduct, by id. */
  conductors: new Set<string>(),
  /** The chat that delegated to each worker, by worker id. */
  parents: {} as Record<string, string>,
  /** Most subagents at once, from Settings. */
  maxSubagents: 2,
  /** Short replies, from Settings. */
  conciseReplies: false,
  /** The project of each chat, by chat id. */
  projects: {} as Record<string, string>,
  /** Saved secrets by scope: a project id or `bot:<id>`. */
  secrets: {} as Record<string, Record<string, string>>,
  secretListeners: [] as Array<(scope: string) => void>
}))

/** An ACP agent that answers every request and gives each session/new a fresh id. */
function fakeAgent(command: string, args: string[], env?: Record<string, string | undefined>): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.args = [command, ...args]
  proc.env = env
  proc.calls = []
  proc.replies = []
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.killed = false
  proc.kill = () => {
    proc.killed = true
    proc.emit('exit', 0)
  }
  let buffer = ''
  proc.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      if (message.id === undefined) continue
      if (!message.method) {
        proc.replies.push(message)
        continue
      }
      proc.calls.push({ method: message.method, params: message.params })
      // Like the real adapters, only Claude Code offers steering into a running turn.
      const result =
        message.method === 'initialize'
          ? command === 'claude-acp'
            ? { _meta: { steering: { supported: true } } }
            : { authMethods: [{ id: 'cached_token' }] }
          : message.method === 'session/new'
            ? { sessionId: `s${++fake.sessions}` }
            : message.method === '_session/steering'
              ? { outcome: fake.steerOutcome }
              : {}
      proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
    }
  })
  fake.procs.push(proc)
  return proc
}

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options?: { env?: Record<string, string | undefined> }) =>
    fakeAgent(command, args, options?.env)
}))
vi.mock('./grokCli', () => ({ grokBinary: () => 'grok' }))
vi.mock('./claudeCli', () => ({ startClaudeAdapter: async () => fakeAgent('claude-acp', [], {}) }))
vi.mock('./browserAgent', () => ({
  BROWSER_SESSION_RULE: 'browser rule',
  agentHookSettings: async () => ({}),
  browserMcpServers: async () => []
}))
vi.mock('./checkpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./checkpoints')>()),
  snapshotBeforeTool: async () => {}
}))
vi.mock('./bots', () => ({
  botMemoryFolder: (botId: string) => `/bots/${botId}/memory`,
  botDocumentsFolder: (botId: string) => `/bots/${botId}/documents`,
  sharedMemoryFolder: () => '/workbench/memory'
}))
vi.mock('./sessions', () => ({ readGrokPlan: () => null }))
vi.mock('./store', () => ({
  chatBot: async (chatId?: string) => (chatId ? (fake.bots[chatId] ?? null) : null),
  claudeModelFor: async () => '',
  getApiKey: async () => null,
  getClaudeModel: async () => '',
  getChat: async (chatId: string) => ({
    id: chatId,
    projectId: fake.projects[chatId] ?? '',
    botId: fake.bots[chatId]?.id,
    conductor: fake.conductors.has(chatId),
    parentChatId: fake.parents[chatId]
  }),
  getEffort: async () => null,
  // As the store reads them: a bot's own model (on Grok) and effort, else none.
  grokModelFor: async (chatId?: string) => {
    const bot = chatId ? fake.bots[chatId] : null
    return (bot?.agent === 'grok' && bot.model) || ''
  },
  effortFor: async (chatId?: string) => (chatId ? fake.bots[chatId]?.effort || null : null),
  getMaxSubagents: async () => fake.maxSubagents,
  getConciseReplies: async () => fake.conciseReplies,
  getMcpServers: async () => fake.mcp,
  getSubagentModel: async () => null,
  skipNewSession: <T,>(value: T) => value
}))
vi.mock('./secrets', () => ({
  envFingerprint: (env: Record<string, string>) => Object.values(env).join('+').length.toString(),
  onSecretsChanged: (listener: (scope: string) => void) => {
    fake.secretListeners.push(listener)
    return () => {}
  },
  secretEnv: async (...scopes: string[]) => Object.assign({}, ...scopes.map((scope) => fake.secrets[scope] ?? {})),
  secretScopes: (chat: { projectId: string; botId?: string }) =>
    [chat.projectId, chat.botId ? `bot:${chat.botId}` : ''].filter(Boolean)
}))

import {
  abortAgent,
  agentGeneration,
  agentKey,
  loadSession,
  newSession,
  promptSession,
  reloadBotSessions,
  sessionAgentKey,
  sessionNeedsReload,
  sessionSupportsSteering,
  steerSession,
  stopAgents
} from './acp'
import { SHORT_REPLIES_RULE } from '../shared/replyStyle'
import { bindPermissionSession, cancelAllPermissions, pendingPermissionRequests } from './permissions'

afterEach(() => {
  cancelAllPermissions()
  stopAgents()
  fake.procs.length = 0
  fake.bots = {}
  fake.mcp = {}
  fake.conductors.clear()
  fake.parents = {}
  fake.maxSubagents = 2
  fake.conciseReplies = false
  fake.projects = {}
  fake.secrets = {}
  fake.steerOutcome = 'injected'
})

function configCalls(proc: FakeProc): Array<[unknown, unknown]> {
  return proc.calls
    .filter((call) => call.method === 'session/set_config_option')
    .map((call) => [call.params.configId, call.params.value])
}

const BOT = '/data/bots/chief'

describe('agent processes for bots', () => {
  it('gives a bot on Grok its own process that loads the bot folder as a plugin', async () => {
    const plain = await newSession('/project', null, 'grok', 'chat-1')
    const bot = await newSession('/project', 'Be the chief.', 'grok', 'chat-2', BOT)
    const again = await newSession('/elsewhere', null, 'grok', 'chat-3', BOT)

    expect(fake.procs.map((proc) => proc.args)).toEqual([
      ['grok', 'agent', '--no-leader', 'stdio'],
      ['grok', 'agent', '--no-leader', '--plugin-dir', BOT, 'stdio']
    ])
    const [shared, own] = fake.procs
    expect(shared.calls.filter((call) => call.method === 'session/new')).toHaveLength(1)
    const botSessions = own.calls.filter((call) => call.method === 'session/new')
    expect(botSessions).toHaveLength(2)
    expect(botSessions[0].params._meta).toEqual({ rules: 'browser rule\n\nBe the chief.' })

    // Prompts go to the process the session lives on.
    await promptSession(bot, 'hello')
    await promptSession(plain, 'hi')
    expect(own.calls.filter((call) => call.method === 'session/prompt').map((call) => call.params.sessionId)).toEqual([bot])
    expect(shared.calls.filter((call) => call.method === 'session/prompt').map((call) => call.params.sessionId)).toEqual([
      plain
    ])
    expect(again).not.toBe(bot)
  })

  it('stops a bot process without touching the shared one', async () => {
    await newSession('/project', null, 'grok', 'chat-1')
    await newSession('/project', null, 'grok', 'chat-2', BOT)
    const key = agentKey('grok', BOT)
    abortAgent(key, agentGeneration(key))
    const [shared, own] = fake.procs
    expect(own.killed).toBe(true)
    expect(shared.killed).toBe(false)
  })

  it("puts a bot's chats on the bot's model and effort, and leaves other chats on the defaults", async () => {
    fake.bots['chat-5'] = { agent: 'grok', model: 'grok-4.6', effort: 'low' }
    fake.bots['chat-6'] = { agent: 'claude', model: 'haiku', effort: 'high' }
    await newSession('/project', null, 'grok', 'chat-1')
    await newSession('/project', null, 'grok', 'chat-5', BOT)
    await newSession('/project', null, 'claude', 'chat-6', BOT)
    const [shared, own, claude] = fake.procs
    expect(configCalls(shared)).toEqual([])
    expect(configCalls(own)).toEqual([
      ['model', 'grok-4.6'],
      ['reasoning_effort', { value: 'low' }]
    ])
    // The model comes from claudeModelFor, which reads the bot itself.
    expect(configCalls(claude)).toEqual([['effort', 'high']])
  })

  it('passes a bot folder to Claude Code as a plugin on its shared process', async () => {
    await newSession('/project', 'Be the chief.', 'claude', 'chat-4', BOT)
    expect(fake.procs.map((proc) => proc.args[0])).toEqual(['claude-acp'])
    const created = fake.procs[0].calls.find((call) => call.method === 'session/new')
    const options = (created?.params._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options
    expect(options.plugins).toEqual([{ type: 'local', path: BOT }])
  })

  it('gives a bot only the MCP servers on its page, and keeps Claude Code\'s own servers out', async () => {
    fake.mcp = { github: { command: 'gh-mcp' }, notes: { type: 'http', url: 'https://notes.test/mcp' } }
    fake.bots['chat-8'] = { id: 'b1', agent: 'claude', model: '', effort: '', mcpServers: ['notes'] }
    await newSession('/project', null, 'claude', 'chat-8', BOT)
    await newSession('/project', null, 'claude', 'chat-1')
    const [botNew, plainNew] = fake.procs[0].calls.filter((call) => call.method === 'session/new')
    const names = (call: Call): string[] => (call.params.mcpServers as Array<{ name: string }>).map((server) => server.name)
    const options = (call: Call): Record<string, unknown> =>
      (call.params._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options
    expect(names(botNew)).toEqual(['notes'])
    expect(options(botNew).strictMcpConfig).toBe(true)
    // A project's chat keeps every server, and Claude Code's own config.
    expect(names(plainNew)).toEqual(['github', 'notes'])
    expect(options(plainNew).strictMcpConfig).toBeUndefined()
    // A bot's memory is the Workbench's, so Claude Code's own is off for it and left alone for a project's chat.
    expect(options(botNew).settings).toEqual({ autoMemoryEnabled: false })
    expect(options(plainNew).settings).toEqual({})
  })

  it("loads a bot's live chats again on their next turn after its MCP servers changed", async () => {
    fake.bots['chat-9'] = { id: 'b2', agent: 'grok', model: '', effort: '', mcpServers: [] }
    fake.bots['chat-10'] = { id: 'b3', agent: 'grok', model: '', effort: '', mcpServers: [] }
    const changed = await newSession('/project', null, 'grok', 'chat-9', BOT)
    const other = await newSession('/project', null, 'grok', 'chat-10', '/data/bots/other')
    await reloadBotSessions('b2')
    expect(sessionNeedsReload(changed)).toBe(true)
    expect(sessionNeedsReload(other)).toBe(false)
    await loadSession(changed, '/project', null, 'grok', 'chat-9', BOT)
    expect(sessionNeedsReload(changed)).toBe(false)
  })

  it("lets a bot run the tools on its list without asking, and asks for the rest", async () => {
    fake.bots['chat-7'] = { agent: 'grok', model: '', effort: '', allowedTools: ['run_terminal_command'] }
    const sessionId = await newSession('/project', null, 'grok', 'chat-7', BOT)
    bindPermissionSession(sessionId, 'chat-7', 'ask')
    const [own] = fake.procs
    const send = (message: Record<string, unknown>): void => {
      own.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    const options = [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' }
    ]
    const toolCall = (id: string, name: string): Record<string, unknown> => ({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: name,
      kind: 'execute',
      _meta: { 'x.ai/tool': { name } }
    })
    // The permission request leaves the name out; it comes from the tool call before it.
    send({ method: 'session/update', params: { sessionId, update: toolCall('t1', 'run_terminal_command') } })
    send({ id: 901, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 't1', title: 'ls' } } })
    send({ method: 'session/update', params: { sessionId, update: toolCall('t2', 'write') } })
    send({ id: 902, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 't2', title: 'notes.md', kind: 'edit' } } })

    await vi.waitFor(() => expect(pendingPermissionRequests()).toHaveLength(1))
    expect(own.replies).toEqual([{ jsonrpc: '2.0', id: 901, result: { outcome: { outcome: 'selected', optionId: 'yes' } } }])
    expect(pendingPermissionRequests()[0]).toMatchObject({ chatId: 'chat-7', title: expect.stringContaining('notes.md') })
  })

  it('lets a bot write its memory and use its own run tools without asking, and asks for edits elsewhere', async () => {
    fake.bots['chat-8'] = { id: 'b8', agent: 'grok', model: '', effort: '', allowedTools: [] }
    const sessionId = await newSession('/project', null, 'grok', 'chat-8', BOT)
    bindPermissionSession(sessionId, 'chat-8', 'ask')
    const [own] = fake.procs
    const send = (message: Record<string, unknown>): void => {
      own.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    const options = [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' }
    ]
    const ask = (id: number, toolCall: Record<string, unknown>): void =>
      send({ id, method: 'session/request_permission', params: { sessionId, options, toolCall } })
    ask(911, { toolCallId: 'm1', title: 'MEMORY.md', kind: 'edit', locations: [{ path: '/bots/b8/memory/MEMORY.md' }] })
    ask(912, { toolCallId: 'm2', title: 'notify', kind: 'other', _meta: { claudeCode: { toolName: 'mcp__workbench__notify' } } })
    ask(913, { toolCallId: 'm3', title: 'escape', kind: 'edit', locations: [{ path: '/bots/b8/memory/../skills/x/SKILL.md' }] })
    ask(914, { toolCallId: 'm4', title: 'relative', kind: 'edit', rawInput: { path: 'memory/MEMORY.md' } })
    ask(915, {
      toolCallId: 'm5',
      title: 'move out',
      kind: 'move',
      locations: [{ path: '/bots/b8/memory/a.md' }],
      rawInput: { source: '/bots/b8/memory/a.md', destination: '/Users/me/.zshrc' }
    })
    ask(916, {
      toolCallId: 'm6',
      title: 'upload',
      kind: 'read',
      rawInput: { path: '/bots/b8/memory/MEMORY.md' },
      _meta: { claudeCode: { toolName: 'mcp__drive__upload' } }
    })

    await vi.waitFor(() => expect(pendingPermissionRequests()).toHaveLength(4))
    expect(own.replies.map((reply) => (reply as { id: number }).id).sort()).toEqual([911, 912])
    expect(pendingPermissionRequests().map((request) => request.title)).toEqual(
      expect.arrayContaining(['escape', 'relative', 'move out', 'upload'].map((title) => expect.stringContaining(title)))
    )
  })

  it('lets a bot read and search its documents and write their outlines without asking, and asks for the rest', async () => {
    fake.bots['chat-d'] = { id: 'bd', agent: 'grok', model: '', effort: '', allowedTools: [] }
    const sessionId = await newSession('/project', null, 'grok', 'chat-d', BOT)
    bindPermissionSession(sessionId, 'chat-d', 'ask')
    const [own] = fake.procs
    const options = [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' }
    ]
    const ask = (id: number, toolCall: Record<string, unknown>): void => {
      own.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId, options, toolCall } })}\n`
      )
    }
    const docs = '/bots/bd/documents'
    ask(961, { toolCallId: 'd1', title: 'read chapter', kind: 'read', locations: [{ path: `${docs}/book/01-intro.md` }] })
    ask(962, { toolCallId: 'd2', title: 'grep', kind: 'search', locations: [], rawInput: { variant: 'Grep', pattern: 'x', path: `${docs}/book` } })
    ask(963, { toolCallId: 'd3', title: 'edit outline', kind: 'edit', locations: [{ path: `${docs}/book/OUTLINE.md` }] })
    ask(964, { toolCallId: 'd4', title: 'edit chapter', kind: 'edit', locations: [{ path: `${docs}/book/01-intro.md` }] })
    ask(965, { toolCallId: 'd5', title: 'outline elsewhere', kind: 'edit', locations: [{ path: '/bots/bd/OUTLINE.md' }] })
    ask(966, { toolCallId: 'd6', title: 'escape read', kind: 'read', locations: [{ path: `${docs}/../../secrets.json` }] })
    ask(967, { toolCallId: 'd7', title: 'escape write', kind: 'edit', locations: [{ path: `${docs}/book/../../skills/OUTLINE.md` }] })
    ask(968, { toolCallId: 'd8', title: 'nested outline', kind: 'edit', locations: [{ path: `${docs}/book/notes/OUTLINE.md` }] })
    // A search of the documents folder itself looks through every book; its parent and a look-alike still ask.
    ask(969, { toolCallId: 'd9', title: 'grep all', kind: 'search', locations: [], rawInput: { variant: 'Grep', pattern: 'x', path: docs } })
    ask(970, { toolCallId: 'd10', title: 'grep bot', kind: 'search', locations: [], rawInput: { variant: 'Grep', pattern: 'x', path: '/bots/bd' } })
    ask(971, {
      toolCallId: 'd11',
      title: 'grep other',
      kind: 'search',
      locations: [],
      rawInput: { variant: 'Grep', pattern: 'x', path: '/bots/bd/documents-other' }
    })

    await vi.waitFor(() => expect(pendingPermissionRequests()).toHaveLength(7))
    expect(own.replies.map((reply) => (reply as { id: number }).id).sort()).toEqual([961, 962, 963, 969])
    expect(pendingPermissionRequests().map((request) => request.title)).toEqual(
      expect.arrayContaining(
        ['edit chapter', 'outline elsewhere', 'escape read', 'escape write', 'nested outline', 'grep bot', 'grep other'].map((title) =>
          expect.stringContaining(title)
        )
      )
    )
  })

  it('lets a bot read the shared memory without asking, and asks before it writes there, in any mode', async () => {
    const options = [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' }
    ]
    const shared = '/workbench/memory/peter.md'
    const calls = [
      { toolCallId: 's1', title: 'read shared', kind: 'read', locations: [{ path: shared }] },
      { toolCallId: 's2', title: 'edit shared', kind: 'edit', locations: [{ path: shared }] },
      { toolCallId: 's3', title: 'move in', kind: 'move', rawInput: { source: '/bots/b9/memory/a.md', destination: shared } },
      { toolCallId: 's4', title: 'edit own', kind: 'edit', locations: [{ path: '/bots/b9/memory/MEMORY.md' }] },
      { toolCallId: 's5', title: 'append', kind: 'execute', rawInput: { command: 'cat >> ~/data/workbench/memory/MEMORY.md' } }
    ]
    const titles = (chatId: string): string[] =>
      pendingPermissionRequests()
        .filter((request) => request.chatId === chatId)
        .map((request) => request.title)

    for (const [index, mode] of (['ask', 'accept'] as const).entries()) {
      const chatId = `chat-9${mode}`
      fake.bots[chatId] = { id: 'b9', agent: 'grok', model: '', effort: '', allowedTools: [] }
      const sessionId = await newSession('/project', null, 'grok', chatId, BOT)
      bindPermissionSession(sessionId, chatId, mode)
      const own = fake.procs[fake.procs.length - 1]
      const first = 920 + index * 10
      for (const [at, toolCall] of calls.entries()) {
        const message = { id: first + at, method: 'session/request_permission', params: { sessionId, options, toolCall } }
        own.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      }
      await vi.waitFor(() => expect(titles(chatId)).toHaveLength(3))
      expect(titles(chatId)).toEqual(
        expect.arrayContaining(['edit shared', 'move in', 'append'].map((title) => expect.stringContaining(title)))
      )
      // Reading the shared memory and writing its own ran without a question.
      const answered = own.replies.map((reply) => (reply as { id: number }).id)
      expect(answered).toEqual(expect.arrayContaining([first, first + 3]))
    }

    // Only the shared folder itself is free to read.
    fake.bots['chat-9out'] = { id: 'b9', agent: 'grok', model: '', effort: '', allowedTools: [] }
    const outside = await newSession('/project', null, 'grok', 'chat-9out', BOT)
    bindPermissionSession(outside, 'chat-9out', 'ask')
    const escape = { toolCallId: 's6', title: 'read outside', kind: 'read', locations: [{ path: '/workbench/memory/../secrets.json' }] }
    fake.procs[fake.procs.length - 1].stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 940, method: 'session/request_permission', params: { sessionId: outside, options, toolCall: escape } })}\n`
    )
    await vi.waitFor(() => expect(titles('chat-9out')).toEqual([expect.stringContaining('read outside')]))

    // A project chat, which is no bot's, is not held to this.
    const sessionId = await newSession('/project', null, 'grok', 'chat-1')
    bindPermissionSession(sessionId, 'chat-1', 'accept')
    const proc = fake.procs[fake.procs.length - 1]
    const message = { id: 950, method: 'session/request_permission', params: { sessionId, options, toolCall: calls[1] } }
    proc.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    await vi.waitFor(() => expect(proc.replies.some((reply) => (reply as { id: number }).id === 950)).toBe(true))
    expect(titles('chat-1')).toEqual([])
  })
})

describe('conductor chats', () => {
  it('tells a conductor its role with every session, in place of the Agent rule', async () => {
    fake.conductors.add('boss')
    await newSession('/project', null, 'claude', 'boss')
    await newSession('/project', null, 'claude', 'chat-1')
    await newSession('/project', null, 'grok', 'boss')
    const [claude, grok] = fake.procs
    const prompts = claude.calls
      .filter((call) => call.method === 'session/new')
      .map((call) => (call.params.systemPrompt as { content: Array<{ text: string }> }).content[0].text)
    expect(prompts[0]).toContain('You are the conductor of this job')
    expect(prompts[0]).not.toContain('you think, agents do the work')
    expect(prompts[1]).not.toContain('You are the conductor')
    expect(prompts[1]).toContain('you think, agents do the work')
    const grokNew = grok.calls.find((call) => call.method === 'session/new')
    expect((grokNew?.params._meta as { rules: string }).rules).toContain('You are the conductor of this job')
  })

  it('has a user chat orchestrate its agents, and a worker or bot do its task itself', async () => {
    fake.parents.worker = 'boss'
    fake.bots['bot-chat'] = { agent: 'claude', model: '', effort: '' }
    await newSession('/project', null, 'claude', 'chat-1')
    await newSession('/project', null, 'claude', 'worker')
    await newSession('/project', null, 'claude', 'bot-chat')
    const prompts = fake.procs
      .flatMap((proc) => proc.calls)
      .filter((call) => call.method === 'session/new')
      .map((call) => (call.params.systemPrompt as { content: Array<{ text: string }> }).content[0].text)
    expect(prompts[0]).toContain('you think, agents do the work')
    for (const prompt of prompts.slice(1)) {
      expect(prompt).toContain('Do your task yourself')
      expect(prompt).not.toContain('orchestrator')
    }
  })

  it('gives a conductor the do-it-yourself rule when Settings allows no subagents', async () => {
    fake.maxSubagents = 0
    fake.conductors.add('boss')
    await newSession('/project', null, 'claude', 'boss')
    const [claude] = fake.procs
    const prompt = (claude.calls.find((call) => call.method === 'session/new')?.params.systemPrompt as {
      content: Array<{ text: string }>
    }).content[0].text
    expect(prompt).not.toContain('You are the conductor')
    expect(prompt).toContain('do this work yourself')
  })

  it("refuses a conductor's own file edits, even when its mode lets edits through", async () => {
    fake.conductors.add('boss')
    const sessionId = await newSession('/project', null, 'grok', 'boss')
    bindPermissionSession(sessionId, 'boss', 'accept')
    const [own] = fake.procs
    const send = (message: Record<string, unknown>): void => {
      own.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    const options = [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' }
    ]
    send({ id: 801, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 'r1', title: 'npm test', kind: 'execute' } } })
    send({ id: 802, method: 'session/request_permission', params: { sessionId, options, toolCall: { toolCallId: 'e1', title: 'notes.md', kind: 'edit' } } })
    await vi.waitFor(() => expect(own.replies).toHaveLength(2))
    expect(own.replies).toEqual([
      { jsonrpc: '2.0', id: 801, result: { outcome: { outcome: 'selected', optionId: 'yes' } } },
      { jsonrpc: '2.0', id: 802, result: { outcome: { outcome: 'selected', optionId: 'no' } } }
    ])
  })
})

describe('steering a running turn', () => {
  it('sends a steer into the running turn on Claude Code, so nothing is cancelled', async () => {
    const sessionId = await newSession('/project', null, 'claude', 'chat-8')
    expect(sessionSupportsSteering(sessionId)).toBe(true)
    const image = { mimeType: 'image/png', data: 'AAAA' }
    await expect(steerSession(sessionId, 'Use the other file.', [image])).resolves.toBe('injected')
    const [claude] = fake.procs
    const steer = claude.calls.find((call) => call.method === '_session/steering')
    expect(steer?.params).toEqual({
      sessionId,
      prompt: [{ type: 'text', text: 'Use the other file.' }, { type: 'image', ...image }],
      _meta: { steering: { idleBehavior: 'promptRequired' } }
    })
    expect(claude.calls.some((call) => call.method === 'session/cancel')).toBe(false)
  })

  it('reports a steer that found no running turn, so it can go out as a prompt of its own', async () => {
    fake.steerOutcome = 'promptRequired'
    const sessionId = await newSession('/project', null, 'claude', 'chat-9')
    await expect(steerSession(sessionId, 'Also check the tests.')).resolves.toBe('idle')
  })

  it('does not steer Grok, which does not offer it', async () => {
    const sessionId = await newSession('/project', null, 'grok', 'chat-10')
    expect(sessionSupportsSteering(sessionId)).toBe(false)
  })
})

describe('short replies', () => {
  const rulesOf = (call: Call | undefined): string => (call?.params._meta as { rules: string }).rules
  const promptOf = (call: Call | undefined): string =>
    (call?.params.systemPrompt as { content: Array<{ text: string }> }).content[0].text

  it('adds nothing by default', async () => {
    await newSession('/project', null, 'grok', 'chat-1')
    await newSession('/project', null, 'claude', 'chat-1')
    const [grok, claude] = fake.procs
    expect(rulesOf(grok.calls.find((call) => call.method === 'session/new'))).not.toContain(SHORT_REPLIES_RULE)
    expect(promptOf(claude.calls.find((call) => call.method === 'session/new'))).not.toContain(SHORT_REPLIES_RULE)
  })

  it("tells a user's own chat, on either agent, and not a worker, a bot's chat with its switch off or a session without a chat", async () => {
    fake.conciseReplies = true
    fake.parents.worker = 'chat-1'
    fake.bots['bot-chat'] = { agent: 'claude', model: '', effort: '', conciseReplies: false }
    await newSession('/project', null, 'grok', 'chat-1')
    await newSession('/project', null, 'grok', 'worker')
    await newSession('/project', null, 'claude', 'chat-1')
    await newSession('/project', null, 'claude', 'worker')
    await newSession('/project', null, 'claude', 'bot-chat')
    await newSession('/project', null, 'claude')
    const [grok, claude] = fake.procs
    const grokNew = grok.calls.filter((call) => call.method === 'session/new')
    expect(rulesOf(grokNew[0])).toContain(SHORT_REPLIES_RULE)
    expect(rulesOf(grokNew[1])).not.toContain(SHORT_REPLIES_RULE)
    const claudeNew = claude.calls.filter((call) => call.method === 'session/new').map(promptOf)
    expect(claudeNew[0]).toContain(SHORT_REPLIES_RULE)
    for (const prompt of claudeNew.slice(1)) expect(prompt).not.toContain(SHORT_REPLIES_RULE)
  })

  it("tells a bot's chat when the bot's own switch is on, whatever Settings says", async () => {
    fake.bots['bot-chat'] = { agent: 'claude', model: '', effort: '', conciseReplies: true }
    await newSession('/project', null, 'claude', 'bot-chat')
    const [claude] = fake.procs
    expect(promptOf(claude.calls.find((call) => call.method === 'session/new'))).toContain(SHORT_REPLIES_RULE)
  })
})

describe('project secrets', () => {
  const rulesOf = (call: Call | undefined): string => (call?.params._meta as { rules: string }).rules

  it('runs a Grok chat with secrets on a process of its own, with the secrets in its environment', async () => {
    fake.projects['chat-s'] = 'p1'
    fake.secrets.p1 = { STRIPE_KEY: 'sk_live_123' }
    await newSession('/project', null, 'grok', 'chat-1')
    await newSession('/project', null, 'grok', 'chat-s')
    const [shared, own] = fake.procs
    expect(fake.procs).toHaveLength(2)
    expect(own.env?.STRIPE_KEY).toBe('sk_live_123')
    expect(shared.env?.STRIPE_KEY).toBeUndefined()
    // The agent is told the name, never the value.
    const rules = rulesOf(own.calls.find((call) => call.method === 'session/new'))
    expect(rules).toContain('STRIPE_KEY')
    expect(rules).not.toContain('sk_live_123')
    expect(rulesOf(shared.calls.find((call) => call.method === 'session/new'))).not.toContain('STRIPE_KEY')
  })

  it("passes a project's secrets to Claude Code per session", async () => {
    fake.projects['chat-c'] = 'p1'
    fake.secrets.p1 = { STRIPE_KEY: 'sk_live_123' }
    await newSession('/project', null, 'claude', 'chat-c')
    await newSession('/project', null, 'claude', 'chat-1')
    const [withSecrets, without] = fake.procs[0].calls.filter((call) => call.method === 'session/new')
    const options = (call: Call): Record<string, unknown> =>
      (call.params._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options
    expect(options(withSecrets).env).toEqual({ STRIPE_KEY: 'sk_live_123', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' })
    expect(options(without).env).toEqual({ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' })
    const prompt = (withSecrets.params.systemPrompt as { content: Array<{ text: string }> }).content[0].text
    expect(prompt).toContain('STRIPE_KEY')
    expect(prompt).not.toContain('sk_live_123')
  })

  it("turns Claude Code's MCP idle limit off, whatever a secret of that name says", async () => {
    fake.projects['chat-c'] = 'p1'
    fake.secrets.p1 = { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '300000' }
    await newSession('/project', null, 'claude', 'chat-c')
    const [call] = fake.procs[0].calls.filter((item) => item.method === 'session/new')
    const options = (call.params._meta as { claudeCode: { options: { env: Record<string, string> } } }).claudeCode.options
    expect(options.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe('0')
  })

  it('moves a live chat to a process with the new secrets on its next turn, and stops the old one', async () => {
    fake.projects['chat-s'] = 'p1'
    fake.projects['chat-other'] = 'p2'
    const sessionId = await newSession('/project', null, 'grok', 'chat-s')
    const other = await newSession('/project', null, 'grok', 'chat-other')
    const [shared] = fake.procs

    // The first secret: the chat leaves the shared process, which keeps running.
    fake.secrets.p1 = { STRIPE_KEY: 'sk_1' }
    for (const listener of fake.secretListeners) listener('p1')
    await vi.waitFor(() => expect(sessionNeedsReload(sessionId)).toBe(true))
    expect(sessionNeedsReload(other)).toBe(false)
    await loadSession(sessionId, '/project', null, 'grok', 'chat-s')
    const first = fake.procs[1]
    expect(first.env?.STRIPE_KEY).toBe('sk_1')
    expect(shared.killed).toBe(false)

    // A changed secret: a new process, and the old one, now empty, stops.
    fake.secrets.p1 = { STRIPE_KEY: 'sk_22' }
    for (const listener of fake.secretListeners) listener('p1')
    await vi.waitFor(() => expect(sessionNeedsReload(sessionId)).toBe(true))
    await loadSession(sessionId, '/project', null, 'grok', 'chat-s')
    expect(fake.procs[2].env?.STRIPE_KEY).toBe('sk_22')
    expect(first.killed).toBe(true)
    await promptSession(sessionId, 'go on')
    expect(fake.procs[2].calls.some((call) => call.method === 'session/prompt')).toBe(true)

    // Deleted secrets: the idle process that still holds them stops at once.
    fake.secrets.p1 = {}
    for (const listener of fake.secretListeners) listener('p1')
    await vi.waitFor(() => expect(fake.procs[2].killed).toBe(true))
    expect(shared.killed).toBe(false)
  })

  it("gives a bot asked from a project the project's secrets and its own, its own winning", async () => {
    fake.projects['chat-run'] = 'p1'
    fake.bots['chat-run'] = { id: 'b1', agent: 'grok', model: '', effort: '' }
    fake.secrets.p1 = { PROJECT_KEY: 'made-up-p', SHARED_KEY: 'made-up-project' }
    fake.secrets['bot:b1'] = { BOT_KEY: 'made-up-b', SHARED_KEY: 'made-up-bot' }
    const sessionId = await newSession('/project', null, 'grok', 'chat-run')
    const [first] = fake.procs
    expect(first.env?.PROJECT_KEY).toBe('made-up-p')
    expect(first.env?.BOT_KEY).toBe('made-up-b')
    expect(first.env?.SHARED_KEY).toBe('made-up-bot')
    const rules = rulesOf(first.calls.find((call) => call.method === 'session/new'))
    expect(rules).toContain('Secrets the user saved for this project and for you')
    expect(rules).toContain('BOT_KEY, PROJECT_KEY, SHARED_KEY')

    // A change to the bot's own secrets reloads the chat and stops the idle process with the old ones.
    fake.secrets['bot:b1'] = { BOT_KEY: 'made-up-b2', SHARED_KEY: 'made-up-bot' }
    for (const listener of fake.secretListeners) listener('bot:b1')
    await vi.waitFor(() => expect(sessionNeedsReload(sessionId)).toBe(true))
    await loadSession(sessionId, '/project', null, 'grok', 'chat-run')
    expect(fake.procs[1].env?.BOT_KEY).toBe('made-up-b2')
    expect(first.killed).toBe(true)

    // So does a change to the project's.
    fake.secrets.p1 = { PROJECT_KEY: 'made-up-p22' }
    for (const listener of fake.secretListeners) listener('p1')
    await vi.waitFor(() => expect(sessionNeedsReload(sessionId)).toBe(true))
    await loadSession(sessionId, '/project', null, 'grok', 'chat-run')
    expect(fake.procs[2].env?.PROJECT_KEY).toBe('made-up-p22')
    expect(fake.procs[2].env?.SHARED_KEY).toBe('made-up-bot')
    expect(fake.procs[1].killed).toBe(true)

    // Deleted secrets of the bot: the idle process that still holds the old ones stops at once.
    fake.secrets['bot:b1'] = {}
    for (const listener of fake.secretListeners) listener('bot:b1')
    await vi.waitFor(() => expect(fake.procs[2].killed).toBe(true))
  })

  it("stops a chat with secrets on its own process, and prompts it without starting the shared one", async () => {
    fake.projects['chat-s'] = 'p1'
    fake.secrets.p1 = { STRIPE_KEY: 'sk_live_123' }
    const sessionId = await newSession('/project', null, 'grok', 'chat-s')
    expect(fake.procs).toHaveLength(1)
    await promptSession(sessionId, 'go')
    expect(fake.procs).toHaveLength(1)

    const key = sessionAgentKey(sessionId)
    expect(key).toMatch(/^grok#p1:/)
    expect(key).not.toContain('sk_live_123')
    await newSession('/project', null, 'grok', 'chat-1')
    const [own, shared] = fake.procs
    abortAgent(key)
    expect(own.killed).toBe(true)
    expect(shared.killed).toBe(false)
  })
})

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Call = { method: string; params: Record<string, unknown> }
type FakeProc = EventEmitter & {
  args: string[]
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
    { id?: string; agent: string; model: string; effort: string; allowedTools?: string[]; mcpServers?: string[] }
  >,
  /** The MCP servers in Settings. */
  mcp: {} as Record<string, unknown>
}))

/** An ACP agent that answers every request and gives each session/new a fresh id. */
function fakeAgent(command: string, args: string[]): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.args = [command, ...args]
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

vi.mock('child_process', () => ({ spawn: (command: string, args: string[]) => fakeAgent(command, args) }))
vi.mock('./grokCli', () => ({ grokBinary: () => 'grok' }))
vi.mock('./claudeCli', () => ({ claudeAcpCommand: async () => ({ command: 'claude-acp', args: [], env: {} }) }))
vi.mock('./browserAgent', () => ({
  BROWSER_SESSION_RULE: 'browser rule',
  agentHookSettings: async () => ({}),
  browserMcpServers: async () => []
}))
vi.mock('./checkpoints', () => ({ snapshotBeforeTool: async () => {} }))
vi.mock('./sessions', () => ({ readGrokPlan: () => null }))
vi.mock('./store', () => ({
  chatBot: async (chatId?: string) => (chatId ? (fake.bots[chatId] ?? null) : null),
  claudeModelFor: async () => '',
  getApiKey: async () => null,
  getClaudeModel: async () => '',
  getEffort: async () => null,
  getMaxSubagents: async () => 2,
  getMcpServers: async () => fake.mcp,
  getSubagentModel: async () => null,
  skipNewSession: <T,>(value: T) => value
}))

import {
  abortAgent,
  agentGeneration,
  agentKey,
  loadSession,
  newSession,
  promptSession,
  reloadBotSessions,
  sessionNeedsReload,
  sessionSupportsSteering,
  steerSession,
  stopAgents
} from './acp'
import { bindPermissionSession, cancelAllPermissions, pendingPermissionRequests } from './permissions'

afterEach(() => {
  cancelAllPermissions()
  stopAgents()
  fake.procs.length = 0
  fake.bots = {}
  fake.mcp = {}
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

import { existsSync } from 'fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgent, type Agent } from './server'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { chatText, chatToolCall, chatToolCalls, fakeProvider, type FakeProvider, type FakeReply } from './testServer'

type Update = Record<string, unknown> & { sessionUpdate: string }
type Wire = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** The app's side of the wire: sends requests, collects updates and answers permission requests. */
function client(home?: string) {
  const updates: Update[] = []
  const commands: Update[] = []
  const asked: Array<Record<string, unknown>> = []
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Wire['error']) => void }>()
  const seen: Array<(update: Update) => void> = []
  let nextId = 1
  const state = { permit: 'allow_once' as string }
  const agent: Agent = createAgent((line) => {
    const message = JSON.parse(line) as Wire
    if (message.method === 'session/update') {
      const update = message.params!.update as Update
      // The command list comes on every new and load; the tests of it read `commands`.
      if (update.sessionUpdate === 'available_commands_update') commands.push(update)
      else updates.push(update)
      for (const listener of seen) listener(update)
    } else if (message.method === 'session/request_permission') {
      asked.push(message.params!)
      send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: state.permit } } })
    } else if (message.id !== undefined) {
      const waiter = waiting.get(message.id)
      waiting.delete(message.id)
      if (message.error) waiter?.reject(message.error)
      else waiter?.resolve(message.result)
    }
  }, { home })
  function send(message: Record<string, unknown>): void {
    agent.feed(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }
  return {
    agent,
    updates,
    commands,
    asked,
    state,
    kinds: () => updates.map((update) => update.sessionUpdate),
    call: <T = Record<string, unknown>>(method: string, params: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
        send({ id, method, params })
      }),
    notify: (method: string, params: unknown) => send({ method, params }),
    /** Resolves when an update of this kind (and, if given, this status and tool name) comes. */
    when: (kind: string, status?: string, name?: string): Promise<Update> =>
      new Promise((resolve) => seen.push((update) => {
        if (update.sessionUpdate === kind && (!status || update.status === status) && (!name || update.name === name)) resolve(update)
      }))
  }
}

let dir = ''
let home = ''
let server: FakeProvider | undefined
const agents: Agent[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-agent-project-'))
  home = await mkdtemp(join(tmpdir(), 'wb-agent-home-'))
})
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()))
  await server?.close()
  server = undefined
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

type Script = FakeReply[] | ((body: Record<string, unknown>, index: number) => FakeReply)

/** An agent with one provider whose model answers from `script`, and one new session. */
async function start(script: Script, options: { model?: Record<string, unknown>; session?: Record<string, unknown>; workbench?: Record<string, unknown>; backend?: string } = {}) {
  server = await fakeProvider((body, index) => (typeof script === 'function' ? script(body, index) : (script[index] ?? chatText('(script ran out)'))))
  const app = client(home)
  agents.push(app.agent)
  const providers = [{
    id: 'p',
    name: 'Test Provider',
    backend: options.backend ?? 'chat_completions',
    baseUrl: server.url,
    apiKey: 'sk-secret-key',
    models: [{ key: 'wb-p-model', id: 'vendor/model', name: 'Test Model', ...options.model }]
  }]
  await app.call('initialize', { protocolVersion: 1 })
  app.notify('_workbench/providers', { providers })
  const created = await app.call<{ sessionId: string; modes: { currentModeId: string; availableModes: Array<{ id: string }> } }>('session/new', {
    cwd: dir,
    mcpServers: [],
    _meta: { workbench: options.workbench ?? {} },
    ...options.session
  })
  const prompt = (text: string) => app.call<{ stopReason: string }>('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text }] })
  return { ...app, providers, sessionId: created.sessionId, modes: created.modes, prompt }
}

const sentMessages = (index: number): Array<Record<string, unknown>> => server!.requests[index].body.messages as Array<Record<string, unknown>>
const sentTools = (index: number): string[] =>
  ((server!.requests[index].body.tools ?? []) as Array<{ function: { name: string } }>).map((tool) => tool.function.name)

describe('the protocol', () => {
  it('initializes without auth methods and can load sessions', async () => {
    const app = client()
    const result = await app.call<Record<string, unknown>>('initialize', { protocolVersion: 1 })
    expect(result).toMatchObject({ protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } })
  })

  it('answers an unknown method with -32601 and an unknown session with -32602', async () => {
    const app = client()
    await expect(app.call('session/fork', {})).rejects.toMatchObject({ code: -32601, message: 'Method not found: session/fork' })
    await expect(app.call('session/prompt', { sessionId: 'nope', prompt: [] })).rejects.toMatchObject({ code: -32602, message: 'Unknown session: nope' })
    await expect(app.call('session/load', { sessionId: 'nope', cwd: dir })).rejects.toMatchObject({ code: -32602 })
  })

  it('offers the modes default and plan', async () => {
    const app = await start([])
    expect(app.modes).toEqual({ currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] })
    await expect(app.call('session/set_mode', { sessionId: app.sessionId, modeId: 'yolo' })).rejects.toMatchObject({ code: -32602 })
    await expect(app.call('session/set_config_option', { sessionId: app.sessionId, configId: 'color', value: 'x' })).rejects.toMatchObject({ code: -32602 })
  })
})

describe('a turn', () => {
  it('streams a reply, reports usage and ends with turn_completed', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'Always use tabs.')
    const app = await start([chatText('Hello there', { prompt_tokens: 200, completion_tokens: 10 })], {
      session: { _meta: { rules: 'Answer in Dutch.', workbench: {} } },
      model: { contextWindow: 50_000 }
    })
    expect(await app.prompt('Hi')).toEqual({ stopReason: 'end_turn' })
    expect(app.kinds()).toEqual(['agent_message_chunk', 'agent_message_chunk', 'usage_update', 'turn_completed'])
    expect(app.updates[2]).toEqual({ sessionUpdate: 'usage_update', used: 210, size: 50_000 })
    expect(app.updates[3]).toEqual({ sessionUpdate: 'turn_completed', stopReason: 'end_turn' })
    const system = sentMessages(0)[0].content as string
    expect(system).toContain('You are the Datapad Workbench agent')
    expect(system).toContain('Test Model from Test Provider')
    expect(system).toContain(dir)
    expect(system).toContain('Always use tabs.')
    expect(system).toContain('Answer in Dutch.')
    expect(system).not.toMatch(/grok|xai/i)
    expect(sentMessages(0)[1]).toEqual({ role: 'user', content: 'Hi' })
    expect(server!.requests[0].headers.authorization).toBe('Bearer sk-secret-key')
  })

  it('runs a tool after asking, shows it in order and hands the result to the model', async () => {
    const app = await start([chatToolCall('write_file', { file_path: 'out/note.txt', content: 'hello' }), chatText('Done')])
    expect(await app.prompt('Write it')).toEqual({ stopReason: 'end_turn' })
    const path = join(dir, 'out/note.txt')
    expect(await readFile(path, 'utf8')).toBe('hello')

    const tool = app.updates.filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(tool.map((update) => [update.sessionUpdate, update.status])).toEqual([
      ['tool_call', 'pending'],
      ['tool_call_update', 'in_progress'],
      ['tool_call_update', 'completed']
    ])
    expect(tool[0]).toMatchObject({
      name: 'write_file',
      title: 'Write out/note.txt',
      kind: 'edit',
      rawInput: { file_path: path, content: 'hello' },
      locations: [{ path }],
      _meta: { 'x.ai/tool': { name: 'write_file' } }
    })
    expect(tool[2]).toMatchObject({
      toolCallId: tool[0].toolCallId,
      kind: 'edit',
      content: [{ type: 'diff', path, oldText: null, newText: 'hello' }, { type: 'content', content: { type: 'text', text: `Created ${path}` } }],
      rawOutput: { output: `Created ${path}` }
    })
    // The app was asked before the file was written, with what it needs for its checkpoint.
    expect(app.asked).toHaveLength(1)
    expect(app.asked[0]).toMatchObject({
      sessionId: app.sessionId,
      toolCall: { toolCallId: tool[0].toolCallId, kind: 'edit', rawInput: { file_path: path }, locations: [{ path }] },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'reject_once', kind: 'reject_once' }]
    })
    expect(sentMessages(1).slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"out/note.txt","content":"hello"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: `Created ${path}` }
    ])
  })

  it('does not run a refused tool and tells the model', async () => {
    const app = await start([chatToolCall('write_file', { file_path: 'note.txt', content: 'hello' }), chatText('Understood')])
    app.state.permit = 'reject_once'
    expect(await app.prompt('Write it')).toEqual({ stopReason: 'end_turn' })
    expect(existsSync(join(dir, 'note.txt'))).toBe(false)
    const tool = app.updates.filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(tool.map((update) => update.status)).toEqual(['pending', 'failed'])
    expect(sentMessages(1).at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'The user refused this tool call.' })
  })

  it('does not ask for a tool that only reads', async () => {
    await writeFile(join(dir, 'a.txt'), 'content of a')
    const app = await start([chatToolCall('read_file', { file_path: 'a.txt' }), chatText('Read')])
    await app.prompt('Read it')
    expect(app.asked).toHaveLength(0)
    expect(sentMessages(1).at(-1)).toMatchObject({ role: 'tool', content: 'content of a' })
  })

  it('answers malformed tool arguments and an unknown tool to the model without failing', async () => {
    const app = await start([chatToolCall('write_file', '{"file_path": "a.txt", "content": '), chatToolCall('teleport', {}, 'call_2'), chatText('Sorry')])
    expect(await app.prompt('Go')).toEqual({ stopReason: 'end_turn' })
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
    expect(app.asked).toHaveLength(0)
    expect((sentMessages(1).at(-1) as { content: string }).content).toMatch(/not valid JSON/)
    expect(sentMessages(2).at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_2', content: 'There is no tool named teleport.' })
    const tool = app.updates.filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(tool.map((update) => [update.kind, update.status])).toEqual([['other', 'pending'], ['other', 'failed'], ['other', 'pending'], ['other', 'failed']])
  })

  it('sends a plan for todo_write and shows no tool call for it', async () => {
    const app = await start([chatToolCall('todo_write', { todos: [{ content: 'Step one', status: 'in_progress' }] }), chatText('Planned')])
    await app.prompt('Plan')
    expect(app.kinds()).toEqual(['usage_update', 'plan', 'agent_message_chunk', 'agent_message_chunk', 'usage_update', 'turn_completed'])
    expect(app.updates[1]).toEqual({ sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'in_progress', priority: 'medium' }] })
  })

  it('fails the prompt with the provider\'s message and status', async () => {
    const app = await start([{ status: 402, body: JSON.stringify({ error: { message: 'This request requires more credits' } }) }])
    await expect(app.prompt('Hi')).rejects.toEqual({ code: -32000, message: 'This request requires more credits (HTTP 402)', data: { status: 402 } })
    // The session is free for the next prompt.
    expect(await app.prompt('Again')).toEqual({ stopReason: 'end_turn' })
  })

  it('fails the prompt with the network error when the provider cannot be reached', async () => {
    const app = await start([])
    app.notify('_workbench/providers', { providers: [{ ...app.providers[0], baseUrl: 'http://127.0.0.1:1' }] })
    await expect(app.prompt('Hi')).rejects.toMatchObject({ code: -32000, message: expect.stringMatching(/fetch failed/) })
  })

  it('says so when no model is set up', async () => {
    const app = await start([])
    app.notify('_workbench/providers', { providers: [] })
    await expect(app.prompt('Hi')).rejects.toMatchObject({ code: -32000, message: expect.stringMatching(/No model is set up/) })
  })

  it('refuses a second prompt while one runs', async () => {
    const app = await start([{ events: [{ choices: [{ delta: { content: 'Thinking' } }] }], hold: true }])
    const first = app.prompt('One')
    await app.when('agent_message_chunk')
    await expect(app.prompt('Two')).rejects.toMatchObject({ code: -32000, message: 'A turn is already running in this session' })
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await first).toEqual({ stopReason: 'cancelled' })
  })

  it('runs two sessions side by side', async () => {
    const app = await start((body) => {
      const messages = body.messages as Array<{ content: string }>
      return chatText(`Echo ${messages.at(-1)!.content}`)
    })
    const other = await app.call<{ sessionId: string }>('session/new', { cwd: dir, mcpServers: [] })
    const [first, second] = await Promise.all([
      app.prompt('one'),
      app.call('session/prompt', { sessionId: other.sessionId, prompt: [{ type: 'text', text: 'two' }] })
    ])
    expect(first).toEqual({ stopReason: 'end_turn' })
    expect(second).toEqual({ stopReason: 'end_turn' })
    expect(server!.requests.map((request) => (request.body.messages as unknown[]).length)).toEqual([2, 2])
  })
})

describe('model, effort and session options', () => {
  it('uses the model and effort the app sets, and sends an effort only to a model that lists it', async () => {
    const app = await start([chatText('a'), chatText('b'), chatText('c')], { workbench: { model: 'wb-p-other', effort: 'high' } })
    const models = [
      { key: 'wb-p-model', id: 'vendor/model', name: 'Test Model' },
      { key: 'wb-p-other', id: 'vendor/other', name: 'Other', efforts: ['low', 'high'] }
    ]
    app.notify('_workbench/providers', { providers: [{ ...app.providers[0], models }] })
    await app.prompt('one')
    expect(server!.requests[0].body).toMatchObject({ model: 'vendor/other', reasoning_effort: 'high' })

    await app.call('session/set_config_option', { sessionId: app.sessionId, configId: 'reasoning_effort', value: 'low' })
    await app.prompt('two')
    expect(server!.requests[1].body).toMatchObject({ model: 'vendor/other', reasoning_effort: 'low' })

    await app.call('session/set_config_option', { sessionId: app.sessionId, configId: 'model', value: 'wb-p-model' })
    await app.prompt('three')
    expect(server!.requests[2].body.model).toBe('vendor/model')
    expect(server!.requests[2].body.reasoning_effort).toBeUndefined()
  })

  it('gives no tools with tools: false and writes nothing when ephemeral', async () => {
    const app = await start([chatText('Just text')], { workbench: { tools: false, ephemeral: true } })
    await app.prompt('Hi')
    expect(server!.requests[0].body.tools).toBeUndefined()
    await app.call('session/close', { sessionId: app.sessionId })
    expect(await readdir(home)).toEqual([])
  })

  it('lists the skills of skillsDir with the path to read', async () => {
    const skills = join(dir, 'skills')
    await mkdir(join(skills, 'deploy'), { recursive: true })
    await writeFile(join(skills, 'deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship the site to production\n---\n\nSteps...')
    const app = await start([chatText('ok')], { workbench: { skillsDir: skills } })
    await app.prompt('Hi')
    expect(sentMessages(0)[0].content).toContain(`- deploy: Ship the site to production (${join(skills, 'deploy/SKILL.md')})`)
  })

  it('sends an image of the prompt, but not to a model that takes none', async () => {
    const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' }
    const app = await start([chatText('a'), chatText('b')])
    await app.call('session/prompt', { sessionId: app.sessionId, prompt: [{ type: 'text', text: 'Look' }, image] })
    expect(sentMessages(0)[1].content).toEqual([{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])
    app.notify('_workbench/providers', { providers: [{ ...app.providers[0], models: [{ ...app.providers[0].models[0], images: false }] }] })
    await app.prompt('Again')
    expect(JSON.stringify(sentMessages(1))).not.toContain('image_url')
    expect(JSON.stringify(sentMessages(1))).toContain('An image was left out')
  })

  it('talks to a messages backend in its own shape', async () => {
    const app = await start([{
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }
      ]
    }], { backend: 'messages' })
    expect(await app.prompt('Hi')).toEqual({ stopReason: 'end_turn' })
    expect(server!.requests[0].path).toBe('/messages')
    expect(app.updates.find((update) => update.sessionUpdate === 'usage_update')).toMatchObject({ used: 43 })
  })
})

describe('modes', () => {
  it('gives the model no write or shell tool in plan mode', async () => {
    const app = await start([chatText('a'), chatText('b'), chatToolCall('write_file', { file_path: 'a.txt', content: 'x' }), chatText('c')])
    await app.prompt('one')
    expect(sentTools(0)).toEqual(['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'run_command', 'fetch_url', 'todo_write', 'task'])

    await app.call('session/set_mode', { sessionId: app.sessionId, modeId: 'plan' })
    expect(app.updates.at(-1)).toEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    await app.prompt('two')
    expect(sentTools(1)).toEqual(['read_file', 'list_files', 'grep', 'fetch_url', 'todo_write', 'task'])
    expect(sentMessages(1)[0].content).toContain('You are in plan mode')

    // A model that calls a hidden tool anyway gets a refusal, and nothing is written.
    await app.prompt('three')
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
    expect(sentMessages(3).at(-1)).toMatchObject({ role: 'tool', content: 'The tool write_file is not available in plan mode.' })

    await app.call('session/set_mode', { sessionId: app.sessionId, modeId: 'default' })
    await app.prompt('four')
    expect(sentTools(4)).toContain('write_file')
  })
})

describe('cancel', () => {
  it('ends a turn whose reply is still streaming', async () => {
    const app = await start([{ events: [{ choices: [{ delta: { content: 'Starting' } }] }], hold: true }, chatText('Later')])
    const turn = app.prompt('Go')
    await app.when('agent_message_chunk')
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    expect(app.updates.at(-1)).toEqual({ sessionUpdate: 'turn_completed', stopReason: 'cancelled' })
    // The session takes the next prompt.
    expect(await app.prompt('Next')).toEqual({ stopReason: 'end_turn' })
  })

  it('kills a running command and ends the turn', async () => {
    const app = await start([chatToolCall('run_command', { command: 'sleep 30; echo finished' }), chatText('After')])
    const started = Date.now()
    const turn = app.prompt('Run')
    await app.when('tool_call_update', 'in_progress')
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(app.updates.filter((update) => update.sessionUpdate === 'tool_call_update').at(-1)).toMatchObject({ status: 'failed', rawOutput: { output: '[Cancelled]' } })
    expect(server!.requests).toHaveLength(1)
    // The cancelled call has a result in the history, so the next request is valid.
    await app.prompt('Next')
    expect(sentMessages(1).slice(2).map((message) => message.role)).toEqual(['assistant', 'tool', 'user'])
  })
})

describe('transcripts', () => {
  it('persists a session and replays it on load', async () => {
    const app = await start([
      { events: [{ choices: [{ delta: { reasoning: 'Let me write' } }] }, ...chatToolCall('write_file', { file_path: 'note.txt', content: 'hello' }).events!] },
      chatText('Written'),
      chatText('Yes')
    ], { workbench: { env: { TOKEN: 'secret-env-value' } } })
    await app.prompt('Write the note')
    await app.call('session/close', { sessionId: app.sessionId })

    const file = join(home, `${app.sessionId}.jsonl`)
    const stored = await readFile(file, 'utf8')
    const lines = stored.trim().split('\n').map((line) => JSON.parse(line) as { type: string; message?: { role: string } })
    expect(lines.map((line) => line.type + (line.message ? `:${line.message.role}` : ''))).toEqual(['meta', 'message:user', 'message:assistant', 'message:user', 'message:assistant'])
    expect(stored).not.toContain('sk-secret-key')
    expect(stored).not.toContain('secret-env-value')

    // Another process: a new agent with the same home.
    const again = client(home)
    agents.push(again.agent)
    again.notify('_workbench/providers', { providers: app.providers })
    const loaded = await again.call<{ modes: { currentModeId: string } }>('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    expect(loaded.modes.currentModeId).toBe('default')
    const path = join(dir, 'note.txt')
    expect(again.updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Write the note' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me write' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        name: 'write_file',
        title: 'Write note.txt',
        kind: 'edit',
        rawInput: { file_path: path, content: 'hello' },
        locations: [{ path }],
        _meta: { 'x.ai/tool': { name: 'write_file' } },
        status: 'completed',
        content: [{ type: 'diff', path, oldText: null, newText: 'hello' }, { type: 'content', content: { type: 'text', text: `Created ${path}` } }],
        rawOutput: { output: `Created ${path}` }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Written' } }
    ])

    // The loaded session carries on with its history.
    await again.call('session/prompt', { sessionId: app.sessionId, prompt: [{ type: 'text', text: 'Is it there?' }] })
    expect(sentMessages(2).slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    // Closing waits for the transcript's last lines.
    await again.call('session/close', { sessionId: app.sessionId })
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(7)
  })

  it('closes the calls of a turn that was cut off, so the loaded history is valid', async () => {
    const call = { type: 'tool_call', id: 'c9', name: 'run_command', input: { command: 'make' } }
    await writeFile(join(home, 'cut.jsonl'), [
      { type: 'meta', sessionId: 'cut', cwd: dir },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Build' }] } },
      { type: 'message', message: { role: 'assistant', content: [call] } }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n')
    const app = await start([chatText('ok')])
    await app.call('session/load', { sessionId: 'cut', cwd: dir, mcpServers: [] })
    expect(app.updates.at(-1)).toMatchObject({ sessionUpdate: 'tool_call', title: 'make', kind: 'execute', status: 'failed' })
    await app.call('session/prompt', { sessionId: 'cut', prompt: [{ type: 'text', text: 'Go on' }] })
    expect(sentMessages(0).slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
  })
})

describe('compaction', () => {
  it('summarises the conversation when it nears the context window', async () => {
    const app = await start([
      chatText('A long answer about the parser', { prompt_tokens: 850, completion_tokens: 50 }),
      chatText('SUMMARY: the user asked about the parser', { prompt_tokens: 900, completion_tokens: 20 }),
      chatText('Carrying on', { prompt_tokens: 60, completion_tokens: 5 })
    ], { model: { contextWindow: 1000 } })
    await app.prompt('Explain the parser')
    expect(app.kinds()).not.toContain('auto_compact_started')

    await app.prompt('And now?')
    expect(app.kinds().slice(4)).toEqual(['auto_compact_started', 'auto_compact_completed', 'agent_message_chunk', 'agent_message_chunk', 'usage_update', 'turn_completed'])
    expect(app.updates[4]).toEqual({ sessionUpdate: 'auto_compact_started', tokens_used: 900, context_window: 1000 })
    expect(app.updates[5]).toMatchObject({ sessionUpdate: 'auto_compact_completed' })
    expect(app.updates[5].tokens_after as number).toBeLessThan(200)

    // The summary call saw the whole conversation; the next call only the summary and the new prompt.
    expect(sentMessages(1).slice(1).map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const after = sentMessages(2).slice(1) as Array<{ role: string; content: string }>
    expect(after.map((message) => message.role)).toEqual(['user', 'user'])
    expect(after[0].content).toContain('SUMMARY: the user asked about the parser')
    expect(JSON.stringify(after)).not.toContain('A long answer')
    expect(after[1].content).toBe('And now?')

    // The transcript keeps every message and marks the compaction; a load starts from the summary.
    await app.call('session/close', { sessionId: app.sessionId })
    const stored = (await readFile(join(home, `${app.sessionId}.jsonl`), 'utf8')).trim().split('\n').map((line) => (JSON.parse(line) as { type: string }).type)
    expect(stored).toEqual(['meta', 'message', 'message', 'compact', 'message', 'message'])
    await app.call('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    await app.call('session/prompt', { sessionId: app.sessionId, prompt: [{ type: 'text', text: 'Third' }] })
    expect(sentMessages(3).slice(1).map((message) => message.role)).toEqual(['user', 'user', 'assistant', 'user'])
  })
})

describe('MCP servers', () => {
  const fixture = { type: 'stdio', name: 'fix', command: process.execPath, args: [join(__dirname, 'fixtures/mcp-server.mjs')], env: [{ name: 'FIXTURE_VALUE', value: 'from-config' }] }
  const broken = { type: 'stdio', name: 'broken', command: join(tmpdir(), 'no-such-mcp-server-binary'), args: [], env: [] }

  it('offers a stdio server\'s tools under mcp__<server>__<tool> and calls them', async () => {
    const app = await start([
      chatToolCall('mcp__fix__echo', { text: 'ping' }),
      chatToolCall('mcp__fix__secret', {}, 'call_2'),
      chatText('Done')
    ], { session: { mcpServers: [broken, fixture] } })
    expect(await app.prompt('Call them')).toEqual({ stopReason: 'end_turn' })
    expect(sentTools(0)).toEqual(expect.arrayContaining(['read_file', 'mcp__fix__echo', 'mcp__fix__secret']))
    expect(sentMessages(1).at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'echo: ping' })
    expect(sentMessages(2).at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'value: from-config' })
    const first = app.updates.find((update) => update.sessionUpdate === 'tool_call')
    expect(first).toMatchObject({ name: 'mcp__fix__echo', title: 'fix: echo', kind: 'other', _meta: { 'x.ai/tool': { name: 'mcp__fix__echo' } } })
    // `echo` is marked read-only, `secret` is not: only that one asks.
    expect(app.asked.map((request) => (request.toolCall as { name: string }).name)).toEqual(['mcp__fix__secret'])
  })

  it('starts a session whose only server fails', async () => {
    const app = await start([chatText('Still here')], { session: { mcpServers: [broken] } })
    expect(await app.prompt('Hi')).toEqual({ stopReason: 'end_turn' })
    expect(sentTools(0)).not.toContain('mcp__broken__anything')
  })
})

/** A web server that answers only once `count` requests wait at the same time; a request alone is told so. */
async function gate(count: number): Promise<{ url: string; server: Server }> {
  const waiting = new Set<() => void>()
  const web = createServer((_request, response) => {
    if (count === 0) return
    const go = (): void => void response.end('together')
    waiting.add(go)
    if (waiting.size >= count) {
      for (const each of waiting) each()
      waiting.clear()
    } else {
      setTimeout(() => waiting.delete(go) && response.end('alone'), 1500).unref()
    }
  })
  await new Promise<void>((done) => web.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(web.address() as AddressInfo).port}`, server: web }
}

const webs: Server[] = []
afterEach(() => {
  for (const web of webs.splice(0)) {
    web.closeAllConnections()
    web.close()
  }
})

const textOfUpdates = (updates: Update[], kind: string): string =>
  updates.filter((update) => update.sessionUpdate === kind).map((update) => (update.content as { text: string }).text).join('')

describe('text of several model calls', () => {
  it('starts each later call\'s thought and text with a blank line, live and on load', async () => {
    await writeFile(join(dir, 'a.txt'), 'A')
    const app = await start([
      chatToolCalls([{ name: 'read_file', input: { file_path: 'a.txt' }, id: 'call_1' }], { reasoning: 'I will read it.', content: 'Reading.' }),
      { events: [{ choices: [{ delta: { reasoning: 'Now I need' } }] }, ...chatText('Done').events!] },
      { events: [{ choices: [{ delta: { reasoning: 'Fresh' } }] }, ...chatText('Second').events!] }
    ])
    await app.prompt('Go')
    expect(textOfUpdates(app.updates, 'agent_thought_chunk')).toBe('I will read it.\n\nNow I need')
    expect(textOfUpdates(app.updates, 'agent_message_chunk')).toBe('Reading.\n\nDone')
    // The history keeps each call's own text.
    expect(sentMessages(1)[2]).toMatchObject({ role: 'assistant', content: 'Reading.' })

    // A new turn starts without one.
    const before = app.updates.length
    await app.prompt('Again')
    expect(textOfUpdates(app.updates.slice(before), 'agent_thought_chunk')).toBe('Fresh')
    expect(textOfUpdates(app.updates.slice(before), 'agent_message_chunk')).toBe('Second')

    await app.call('session/close', { sessionId: app.sessionId })
    const again = client(home)
    agents.push(again.agent)
    await again.call('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    expect(again.updates.filter((update) => update.sessionUpdate.endsWith('_chunk')).map((update) => (update.content as { text: string }).text)).toEqual([
      'Go', 'I will read it.', 'Reading.', '\n\nNow I need', '\n\nDone', 'Again', 'Fresh', 'Second'
    ])
  })
})

describe('tool calls of one reply', () => {
  it('runs calls that change nothing at the same time', async () => {
    const web = await gate(2)
    webs.push(web.server)
    const app = await start([
      chatToolCalls([
        { name: 'fetch_url', input: { url: `${web.url}/one` }, id: 'call_1' },
        { name: 'fetch_url', input: { url: `${web.url}/two` }, id: 'call_2' }
      ]),
      chatText('Fetched')
    ])
    expect(await app.prompt('Fetch both')).toEqual({ stopReason: 'end_turn' })
    expect(sentMessages(1).slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'together' },
      { role: 'tool', tool_call_id: 'call_2', content: 'together' }
    ])
    const pending = app.updates.filter((update) => update.sessionUpdate === 'tool_call').map((update) => update.toolCallId)
    expect(pending).toEqual(['call-1', 'call-2'])
  })

  it('keeps a write in the model\'s order: reads after it wait and see it', async () => {
    await writeFile(join(dir, 'a.txt'), 'old')
    const app = await start([
      chatToolCalls([
        { name: 'read_file', input: { file_path: 'a.txt' }, id: 'call_1' },
        { name: 'write_file', input: { file_path: 'a.txt', content: 'new' }, id: 'call_2' },
        { name: 'read_file', input: { file_path: 'a.txt' }, id: 'call_3' }
      ]),
      chatText('Done')
    ])
    await app.prompt('Go')
    const path = join(dir, 'a.txt')
    expect(sentMessages(1).slice(-3)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'old' },
      { role: 'tool', tool_call_id: 'call_2', content: `Replaced ${path}` },
      { role: 'tool', tool_call_id: 'call_3', content: 'new' }
    ])
    const order = app.updates.filter((update) => update.sessionUpdate.startsWith('tool_call')).map((update) => `${update.toolCallId}:${update.status}`)
    expect(order).toEqual([
      'call-1:pending', 'call-1:in_progress', 'call-1:completed',
      'call-2:pending', 'call-2:in_progress', 'call-2:completed',
      'call-3:pending', 'call-3:in_progress', 'call-3:completed'
    ])
  })

  it('gives every call a result when a cancel stops calls that run together', async () => {
    const web = await gate(0)
    webs.push(web.server)
    const app = await start([
      chatToolCalls([
        { name: 'fetch_url', input: { url: `${web.url}/a` }, id: 'call_1' },
        { name: 'fetch_url', input: { url: `${web.url}/b` }, id: 'call_2' },
        { name: 'write_file', input: { file_path: 'x.txt', content: 'x' }, id: 'call_3' }
      ]),
      chatText('Next')
    ])
    const turn = app.prompt('Go')
    await app.when('tool_call_update', 'in_progress')
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    expect(existsSync(join(dir, 'x.txt'))).toBe(false)
    await app.prompt('Next')
    expect(sentMessages(1).slice(2).map((message) => [message.role, message.content])).toEqual([
      ['assistant', ''], ['tool', 'Cancelled'], ['tool', 'Cancelled'], ['tool', 'Cancelled'], ['user', 'Next']
    ])
  })
})

describe('the task tool', () => {
  const isSub = (body: Record<string, unknown>): boolean => ((body.messages as Array<{ content: string }>)[0].content).includes('# Subagent')

  it('runs a subagent on a fresh context and answers with its last text', async () => {
    const app = await start([
      chatToolCall('task', { description: 'Write the note', prompt: 'Write note.txt with hi' }),
      chatToolCall('write_file', { file_path: 'note.txt', content: 'hi' }, 'sub_1'),
      chatText('Wrote note.txt'),
      chatText('All done')
    ])
    expect(await app.prompt('Delegate it')).toEqual({ stopReason: 'end_turn' })
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hi')

    const sub = server!.requests[1].body
    expect(isSub(sub)).toBe(true)
    expect((sub.messages as unknown[]).slice(1)).toEqual([{ role: 'user', content: 'Write note.txt with hi' }])
    expect(sentTools(1)).not.toContain('task')
    expect(sentTools(1)).not.toContain('todo_write')
    expect(sentTools(1)).toContain('write_file')

    // The subagent's call shows and asks like any other; its text is not streamed.
    const tool = app.updates.filter((update) => update.sessionUpdate.startsWith('tool_call')).map((update) => `${update.name}:${update.status}`)
    expect(tool).toEqual(['task:pending', 'task:in_progress', 'write_file:pending', 'write_file:in_progress', 'write_file:completed', 'task:completed'])
    expect(app.updates.find((update) => update.sessionUpdate === 'tool_call')).toMatchObject({ kind: 'think', title: 'Task: Write the note' })
    expect(app.asked.map((request) => (request.toolCall as { name: string }).name)).toEqual(['write_file'])
    expect(textOfUpdates(app.updates, 'agent_message_chunk')).toBe('All done')
    expect(app.updates.filter((update) => update.name === 'task').at(-1)).toMatchObject({ rawOutput: { output: 'Wrote note.txt' } })
    expect(sentMessages(3).at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Wrote note.txt' })

    // Only the task call and its result are kept.
    await app.call('session/close', { sessionId: app.sessionId })
    const stored = await readFile(join(home, `${app.sessionId}.jsonl`), 'utf8')
    expect(stored).not.toContain('write_file')
    expect(stored.trim().split('\n')).toHaveLength(5)
  })

  it('runs several tasks at the same time', async () => {
    const web = await gate(2)
    webs.push(web.server)
    const app = await start((body) => {
      const messages = body.messages as Array<{ role: string; content: string }>
      if (!isSub(body)) {
        return messages.at(-1)!.role === 'tool'
          ? chatText('Both done')
          : chatToolCalls([
              { name: 'task', input: { description: 'A', prompt: 'Fetch a' }, id: 'call_a' },
              { name: 'task', input: { description: 'B', prompt: 'Fetch b' }, id: 'call_b' }
            ])
      }
      const which = messages[1].content.slice(-1)
      return messages.at(-1)!.role === 'tool'
        ? chatText(`${which} got ${messages.at(-1)!.content}`)
        : chatToolCall('fetch_url', { url: `${web.url}/${which}` }, `sub_${which}`)
    })
    await app.prompt('Both')
    expect(sentMessages(server!.requests.length - 1).slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'call_a', content: 'a got together' },
      { role: 'tool', tool_call_id: 'call_b', content: 'b got together' }
    ])
  })

  it('stops the subagent on cancel', async () => {
    const app = await start([
      chatToolCall('task', { description: 'Build', prompt: 'Run the build' }),
      chatToolCall('run_command', { command: 'sleep 30' }, 'sub_1')
    ])
    const started = Date.now()
    const turn = app.prompt('Go')
    await app.when('tool_call_update', 'in_progress', 'run_command')
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(app.updates.filter((update) => update.name === 'task').at(-1)).toMatchObject({ status: 'failed', rawOutput: { output: 'Cancelled' } })
    expect(server!.requests).toHaveLength(2)
  })
})

describe('/compact', () => {
  it('is announced on new and load', async () => {
    const app = await start([chatText('ok')])
    await app.prompt('Hi')
    const announced = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: expect.any(String), input: { hint: expect.any(String) } }]
    }
    expect(app.commands).toEqual([announced])
    await app.call('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    await new Promise((done) => setImmediate(done))
    expect(app.commands).toEqual([announced, announced])
  })

  it('compacts now with the user\'s instructions and does not send the command to the model', async () => {
    const app = await start([
      chatText('A long answer', { prompt_tokens: 300, completion_tokens: 20 }),
      chatText('SUMMARY of it'),
      chatText('Carrying on')
    ])
    await app.prompt('Explain')
    const before = app.updates.length
    expect(await app.prompt('/compact keep the names')).toEqual({ stopReason: 'end_turn' })
    const after = app.updates.slice(before)
    expect(after.map((update) => update.sessionUpdate)).toEqual(['auto_compact_started', 'auto_compact_completed', 'usage_update', 'agent_message_chunk', 'turn_completed'])
    expect(after[0]).toMatchObject({ tokens_used: 320 })
    expect((after[3].content as { text: string }).text).toMatch(/^Compacted the conversation from 320 to \d+ tokens\.$/)
    const ask = sentMessages(1).at(-1) as { role: string; content: string }
    expect(ask.content).toContain('What the user asks of this summary: keep the names')
    expect(JSON.stringify(sentMessages(1))).not.toContain('/compact')

    await app.prompt('Next')
    const next = sentMessages(2).slice(1) as Array<{ content: string }>
    expect(next).toHaveLength(2)
    expect(next[0].content).toContain('SUMMARY of it')
    expect(next[1].content).toBe('Next')
  })

  it('says so when there is nothing to compact', async () => {
    const app = await start([])
    expect(await app.prompt('/compact')).toEqual({ stopReason: 'end_turn' })
    expect(textOfUpdates(app.updates, 'agent_message_chunk')).toBe('There is nothing to compact yet.')
    expect(server!.requests).toHaveLength(0)
  })
})

describe('a reply cut off by cancel', () => {
  it('keeps what was streamed in the history and the transcript', async () => {
    const app = await start([
      { events: [{ choices: [{ delta: { reasoning: 'Hmm' } }] }, { choices: [{ delta: { content: 'Starting the' } }] }], hold: true },
      chatText('Later')
    ])
    const turn = app.prompt('Go')
    await app.when('agent_message_chunk')
    app.notify('session/cancel', { sessionId: app.sessionId })
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    await app.prompt('Go on')
    expect(sentMessages(1).slice(1)).toEqual([
      { role: 'user', content: 'Go' },
      { role: 'assistant', content: 'Starting the' },
      { role: 'user', content: 'Go on' }
    ])
    await app.call('session/close', { sessionId: app.sessionId })
    const again = client(home)
    agents.push(again.agent)
    await again.call('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    expect(again.updates.slice(0, 3)).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Go' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting the' } }
    ])
  })
})

describe('mode in _meta.workbench', () => {
  it('starts a new or loaded session in the mode it names', async () => {
    const app = await start([chatText('a')], { workbench: { mode: 'plan' } })
    expect(app.modes.currentModeId).toBe('plan')
    await app.prompt('Hi')
    expect(sentTools(0)).not.toContain('write_file')
    const loaded = await app.call<{ modes: { currentModeId: string } }>('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [], _meta: { workbench: { mode: 'plan' } } })
    expect(loaded.modes.currentModeId).toBe('plan')
    const plain = await app.call<{ modes: { currentModeId: string } }>('session/load', { sessionId: app.sessionId, cwd: dir, mcpServers: [] })
    expect(plain.modes.currentModeId).toBe('default')
  })
})

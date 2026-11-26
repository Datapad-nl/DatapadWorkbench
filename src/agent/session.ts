import { appendFile, mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { chatCompletions } from './chatCompletions'
import { connectMcp, type McpConnection, type McpServer } from './mcp'
import { anthropicMessages } from './messages'
import { RpcError } from './rpc'
import { builtinTools, PLAN_HIDDEN, planEntries, SUBTASK_HIDDEN, taskTool, type Tool, type ToolResult } from './tools'
import type { Block, Message, ModelReply, Provider, ProviderModel, StreamHandlers, ToolCallBlock, ToolResultBlock } from './types'

const DEFAULT_WINDOW = 128_000
/** The share of the context window at which the conversation is summarised. */
const COMPACT_AT = 0.8
const REFUSED = 'The user refused this tool call.'
const INSTRUCTION_CHARS = 40_000

export const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'plan', name: 'Plan' }
]

const SUMMARY_PROMPT =
  'The conversation is to be replaced by a summary to save room. Do not call a tool. Write a summary that lets ' +
  'you carry on with nothing else to go on: what the user asked for (their latest request word for word), what ' +
  'was decided, which files were read or changed and how, the commands that mattered and their outcome, the ' +
  'state of the plan, and what is left to do next.'
const QUIET: StreamHandlers = { onText: () => {}, onThought: () => {} }

/** The agent's own slash commands, as `available_commands_update` lists them. */
export const COMMANDS = [
  {
    name: 'compact',
    description: 'Replace the conversation with a summary to free context',
    input: { hint: 'what the summary should keep' }
  }
]
const SUMMARY_HEAD =
  'The conversation up to here was replaced by this summary to save room. Carry on from it; do not ask the ' +
  'user to repeat anything.\n\n'

/** What a session needs from the process around it. */
export type SessionHost = {
  /** Folder for transcripts; without it nothing is kept. */
  home: string | undefined
  providers: () => Provider[]
  update: (sessionId: string, update: Record<string, unknown>) => void
  /** The app's answer to `session/request_permission`. */
  permission: (sessionId: string, toolCall: Record<string, unknown>) => Promise<unknown>
  log: (line: string) => void
}

export type SessionParams = {
  cwd?: unknown
  mcpServers?: unknown
  _meta?: {
    rules?: unknown
    workbench?: {
      model?: unknown
      effort?: unknown
      env?: unknown
      skillsDir?: unknown
      ephemeral?: unknown
      tools?: unknown
      mode?: unknown
    }
  }
}

type Shown = {
  toolCallId: string
  name: string
  title: string
  kind: string
  rawInput: Record<string, unknown>
  locations: Array<{ path: string }>
  _meta: Record<string, unknown>
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const textOf = (blocks: Block[]): string => blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
const failure = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

/** The summary instructions of a prompt that is `/compact`, or null for any other prompt. */
function compactCommand(message: Message): string | null {
  if (!message.content.every((block) => block.type === 'text')) return null
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(textOf(message.content).trim())
  return match ? (match[1] ?? '').trim() : null
}

/** A rough token count for when the provider gave none: four characters a token, images not counted. */
function estimate(value: unknown): number {
  return Math.ceil(JSON.stringify(value, (key, item: unknown) => (key === 'data' ? undefined : item)).length / 4)
}

function userMessage(prompt: unknown): Message {
  const content: Block[] = []
  for (const block of Array.isArray(prompt) ? (prompt as Array<Record<string, unknown>>) : []) {
    if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
    else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      content.push({ type: 'text', text: block.uri })
    } else if (block?.type === 'resource') {
      const resource = block.resource as { uri?: unknown; text?: unknown } | undefined
      if (typeof resource?.text === 'string') content.push({ type: 'text', text: `${str(resource.uri)}\n${resource.text}`.trim() })
    }
  }
  if (content.length === 0) throw new RpcError(-32602, 'The prompt has no text or image')
  return { role: 'user', content }
}

const NO_IMAGE = { type: 'text', text: '[An image was left out: this model takes no images.]' } as const

/** The message for a model that takes no images. */
function withoutImages(message: Message): Message {
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === 'image') return NO_IMAGE
      if (block.type !== 'tool_result') return block
      return { ...block, content: block.content.map((item) => (item.type === 'image' ? NO_IMAGE : item)) }
    })
  }
}

function describe(call: ToolCallBlock, tool: Tool | undefined, cwd: string, toolCallId: string): Shown {
  const prepared =
    tool && !call.error ? tool.prepare(call.input, cwd) : { input: call.input, title: call.name || 'Tool call', locations: [] }
  return {
    toolCallId,
    name: call.name,
    title: prepared.title,
    kind: tool && !call.error ? tool.kind : 'other',
    rawInput: prepared.input,
    locations: prepared.locations.map((path) => ({ path })),
    _meta: { 'x.ai/tool': { name: call.name } }
  }
}

function shownContent(result: ToolResult): unknown[] {
  return [
    ...(result.diff ? [{ type: 'diff', ...result.diff }] : []),
    ...result.content.map((content) => ({ type: 'content', content }))
  ]
}

/** The diff of a stored write or edit, for the replay: the file as it was is not kept. */
function storedDiff(shown: Shown): ToolResult['diff'] {
  const { file_path: path, content, old_string: oldText, new_string: newText } = shown.rawInput
  if (typeof path !== 'string') return undefined
  if (shown.name === 'write_file' && typeof content === 'string') return { path, oldText: null, newText: content }
  if (shown.name === 'edit_file' && typeof oldText === 'string' && typeof newText === 'string') return { path, oldText, newText }
  return undefined
}

async function skillsList(dir: string): Promise<string> {
  const names = await readdir(dir).catch(() => [] as string[])
  const lines: string[] = []
  for (const name of names.sort()) {
    const path = join(dir, name, 'SKILL.md')
    const body = await readFile(path, 'utf8').catch(() => null)
    if (body === null) continue
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? ''
    const field = (key: string): string => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1].trim().replace(/^["']|["']$/g, '') ?? ''
    lines.push(`- ${field('name') || name}: ${field('description')} (${path})`)
  }
  return lines.join('\n')
}

export class Session {
  mode = 'default'
  private cwd: string
  private modelKey: string
  private effort: string
  private env: Record<string, string> = {}
  private rules: string
  private skillsDir: string
  private toolsOn: boolean
  private file: string | undefined
  /** What the model is sent: every message since the start or the last summary. */
  private context: Message[] = []
  private used = 0
  private turn: AbortController | null = null
  private mcp: McpConnection = { tools: [], close: async () => {} }
  private writes: Promise<unknown> = Promise.resolve()
  private callCount = 0

  private constructor(
    private host: SessionHost,
    readonly id: string,
    params: SessionParams
  ) {
    const workbench = params._meta?.workbench ?? {}
    this.cwd = str(params.cwd) || process.cwd()
    this.modelKey = str(workbench.model)
    this.effort = str(workbench.effort)
    this.rules = str(params._meta?.rules)
    this.skillsDir = str(workbench.skillsDir)
    this.toolsOn = workbench.tools !== false
    if (workbench.mode === 'default' || workbench.mode === 'plan') this.mode = workbench.mode
    if (workbench.env && typeof workbench.env === 'object') {
      for (const [key, value] of Object.entries(workbench.env)) if (typeof value === 'string') this.env[key] = value
    }
    if (host.home && workbench.ephemeral !== true) this.file = join(host.home, `${id}.jsonl`)
  }

  static async create(host: SessionHost, id: string, params: SessionParams): Promise<Session> {
    const session = new Session(host, id, params)
    if (session.file && host.home) {
      session.writes = mkdir(host.home, { recursive: true })
      session.record({ type: 'meta', sessionId: id, cwd: session.cwd, createdAt: new Date().toISOString() })
    }
    await session.connect(params.mcpServers)
    return session
  }

  /** Open a stored session and show the app what was said in it. */
  static async load(host: SessionHost, id: string, params: SessionParams): Promise<Session> {
    const unknown = new RpcError(-32602, `Unknown session: ${id}`)
    // The id names a file, so it may not hold a path.
    if (!host.home || !/^[\w-]+$/.test(id)) throw unknown
    const stored = await readFile(join(host.home, `${id}.jsonl`), 'utf8').catch(() => null)
    if (stored === null) throw unknown
    const session = new Session(host, id, params)
    await session.connect(params.mcpServers)
    session.replay(stored)
    return session
  }

  modes(): { currentModeId: string; availableModes: typeof MODES } {
    return { currentModeId: this.mode, availableModes: MODES }
  }

  setMode(modeId: string): void {
    if (!MODES.some((mode) => mode.id === modeId)) throw new RpcError(-32602, `Unknown mode: ${modeId}`)
    this.mode = modeId
    this.update({ sessionUpdate: 'current_mode_update', currentModeId: modeId })
  }

  setModel(key: string): void {
    this.modelKey = key
  }

  setEffort(effort: string): void {
    this.effort = effort
  }

  cancel(): void {
    this.turn?.abort()
  }

  async close(): Promise<void> {
    this.cancel()
    await this.mcp.close()
    await this.writes
  }

  async prompt(prompt: unknown): Promise<{ stopReason: string }> {
    if (this.turn) throw new RpcError(-32000, 'A turn is already running in this session')
    const message = userMessage(prompt)
    const compact = compactCommand(message)
    const turn = (this.turn = new AbortController())
    try {
      const stopReason = compact === null ? await this.run(message, turn.signal) : await this.compactNow(compact, turn.signal)
      this.update({ sessionUpdate: 'turn_completed', stopReason })
      return { stopReason }
    } finally {
      this.turn = null
    }
  }

  private async connect(servers: unknown): Promise<void> {
    if (!this.toolsOn || !Array.isArray(servers) || servers.length === 0) return
    this.mcp = await connectMcp(servers as McpServer[], this.cwd, this.host.log)
  }

  private update(update: Record<string, unknown>): void {
    this.host.update(this.id, update)
  }

  /** Append a line to the transcript. Lines are written in the order they were recorded. */
  private record(line: Record<string, unknown>): void {
    const file = this.file
    if (!file) return
    this.writes = this.writes
      .then(() => appendFile(file, JSON.stringify(line) + '\n'))
      .catch((error: Error) => this.host.log(`transcript ${this.id} was not written: ${error.message}`))
  }

  private push(message: Message): void {
    this.context.push(message)
    this.record({ type: 'message', message })
  }

  private task = taskTool((prompt, signal) => this.subtask(prompt, signal))

  /** Every tool of the session, or of a subagent (`nested`). */
  private allTools(nested = false): Tool[] {
    const tools = [...builtinTools, this.task, ...this.mcp.tools]
    return nested ? tools.filter((tool) => !SUBTASK_HIDDEN.has(tool.spec.name)) : tools
  }

  /** The tools the model is given now. */
  private offered(nested = false): Tool[] {
    if (!this.toolsOn) return []
    const tools = this.allTools(nested)
    return this.mode === 'plan' ? tools.filter((tool) => !PLAN_HIDDEN.has(tool.spec.name)) : tools
  }

  private target(): { provider: Provider; model: ProviderModel } {
    const providers = this.host.providers()
    for (const provider of providers) {
      const model = provider.models.find((item) => item.key === this.modelKey)
      if (model) return { provider, model }
    }
    const provider = providers.find((item) => item.models.length > 0)
    if (!provider) throw new RpcError(-32000, 'No model is set up. Add a provider with a model in Settings.')
    return { provider, model: provider.models[0] }
  }

  /** The parts of the system prompt that are read from disk, once a turn. */
  private async instructions(): Promise<string> {
    const parts: string[] = []
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const body = await readFile(join(this.cwd, name), 'utf8').catch(() => '')
      if (body.trim()) parts.push(`# Project instructions (${name})\n\n${body.trim().slice(0, INSTRUCTION_CHARS)}`)
    }
    if (this.rules.trim()) parts.push(`# Session rules\n\n${this.rules.trim()}`)
    const skills = this.skillsDir && this.toolsOn ? await skillsList(this.skillsDir) : ''
    if (skills) {
      parts.push(
        '# Skills\n\nEach skill is a file of instructions for one kind of task. When a task matches one, read its ' +
          `file with read_file before you start and follow it.\n\n${skills}`
      )
    }
    return parts.join('\n\n')
  }

  private system(instructions: string, provider: Provider, model: ProviderModel, nested: boolean): string {
    const parts = [
      `You are the Datapad Workbench agent, a coding agent that works in the user's project. You are running on the model ${model.name} from ${provider.name}.`
    ]
    if (this.toolsOn) {
      parts.push(
        [
          '# How you work',
          '- Use your tools to do the task; do not tell the user to do what you can do yourself.',
          '- Read a file before you change it, and look at the code around a change so it fits.',
          '- Change only what the task needs. Prefer edit_file for a change to an existing file.',
          '- After a change, check it when you can: run the tests, the type check or the program.',
          ...(nested ? [] : ['- For a task of several steps, keep a plan with todo_write.']),
          '- Writing a file and running a command need the user\'s approval. When a call is refused, do not try it again another way; ask or go on without it.',
          '- Relative paths are relative to the project folder.',
          '- Answer in short, plain text. Say what you did and what you could not do.'
        ].join('\n')
      )
    }
    if (nested) {
      parts.push(
        '# Subagent\n\nAnother agent gave you the task in the first message. It sees nothing of your work but ' +
          'your last reply, and you cannot ask it or the user anything. Do the task, then reply with a report ' +
          'that holds what it asked for: what you found or changed, with file paths.'
      )
    }
    if (this.mode === 'plan' && this.toolsOn) {
      parts.push(
        '# Plan mode\n\nYou are in plan mode. Do not change anything: you have no tools to write files or run ' +
          'commands. Read what you need, then answer with a plan of the changes you would make.'
      )
    }
    parts.push(
      `# Environment\n\n- Project folder: ${this.cwd}\n- Platform: ${process.platform}\n- Date: ${new Date().toISOString().slice(0, 10)}`
    )
    if (instructions) parts.push(instructions)
    return parts.join('\n\n')
  }

  private async callModel(
    instructions: string,
    messages: Message[],
    signal: AbortSignal,
    on: StreamHandlers,
    nested = false
  ): Promise<ModelReply> {
    const { provider, model } = this.target()
    const client = provider.backend === 'messages' ? anthropicMessages : chatCompletions
    try {
      return await client(
        {
          provider,
          model,
          system: this.system(instructions, provider, model, nested),
          messages: model.images === false ? messages.map(withoutImages) : messages,
          tools: this.offered(nested).map((tool) => tool.spec),
          // An effort the model does not list would be refused by its API.
          effort: model.efforts?.includes(this.effort) ? this.effort : undefined
        },
        signal,
        on
      )
    } catch (error) {
      if (error instanceof RpcError || signal.aborted) throw error
      // A connection that failed: fetch keeps the reason in `cause`.
      const cause = (error as { cause?: { message?: unknown } }).cause?.message
      const message = error instanceof Error ? error.message : String(error)
      throw new RpcError(-32000, typeof cause === 'string' && cause ? `${message}: ${cause}` : message)
    }
  }

  private async run(message: Message, signal: AbortSignal): Promise<string> {
    try {
      const instructions = await this.instructions()
      await this.compactIfNeeded(instructions, signal)
      this.push(message)
      // The app joins a turn's chunks into one text, so a later model call's text starts a paragraph.
      const shown = { text: false, thought: false }
      for (;;) {
        const partial = { text: '', thought: '' }
        const stream =
          (kind: 'text' | 'thought', sessionUpdate: string) =>
          (text: string): void => {
            const lead = !partial[kind] && shown[kind] ? '\n\n' : ''
            partial[kind] += text
            shown[kind] = true
            this.update({ sessionUpdate, content: { type: 'text', text: lead + text } })
          }
        let reply: ModelReply
        try {
          reply = await this.callModel(instructions, this.context, signal, {
            onText: stream('text', 'agent_message_chunk'),
            onThought: stream('thought', 'agent_thought_chunk')
          })
        } catch (error) {
          // What the user saw of a reply that was cut off stays, so the model and a load see it too.
          const content: Block[] = []
          if (partial.thought) content.push({ type: 'thinking', text: partial.thought })
          if (partial.text) content.push({ type: 'text', text: partial.text })
          if (signal.aborted && content.length > 0) this.push({ role: 'assistant', content })
          throw error
        }
        if (reply.content.length > 0) this.push({ role: 'assistant', content: reply.content })
        this.used = reply.used || estimate(this.context)
        this.update({ sessionUpdate: 'usage_update', used: this.used, size: this.window() })
        const calls = reply.content.filter((block) => block.type === 'tool_call')
        if (calls.length === 0) return reply.truncated ? 'max_tokens' : 'end_turn'
        this.push({ role: 'user', content: await this.runCalls(calls, signal, false) })
        if (signal.aborted) return 'cancelled'
        await this.compactIfNeeded(instructions, signal)
      }
    } catch (error) {
      if (signal.aborted) return 'cancelled'
      throw error
    }
  }

  /**
   * Run the calls of one reply; the results are in the calls' order. Calls that ask nothing and change
   * nothing run side by side; any other call waits for the calls before it, and the calls after it wait
   * for it. Every call gets a result, also after a cancel: a call without one makes the history invalid.
   */
  private async runCalls(calls: ToolCallBlock[], signal: AbortSignal, nested: boolean): Promise<ToolResultBlock[]> {
    const tools = this.offered(nested)
    const results: ToolResultBlock[] = []
    let together: ToolCallBlock[] = []
    const flush = async (): Promise<void> => {
      results.push(...(await Promise.all(together.map((call) => this.runCall(call, signal, nested)))))
      together = []
    }
    for (const call of calls) {
      const tool = tools.find((item) => item.spec.name === call.name)
      if (call.error || !tool || (!tool.asks && !tool.hidden)) {
        together.push(call)
        continue
      }
      await flush()
      results.push(await this.runCall(call, signal, nested))
    }
    await flush()
    return results
  }

  /** A `task` call: an agent loop on a fresh context. Its tool calls show as any other; its text does not. */
  private async subtask(prompt: string, signal: AbortSignal): Promise<ToolResult> {
    const instructions = await this.instructions()
    const context: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    for (;;) {
      const reply = await this.callModel(instructions, context, signal, QUIET, true)
      if (reply.content.length > 0) context.push({ role: 'assistant', content: reply.content })
      const calls = reply.content.filter((block) => block.type === 'tool_call')
      if (calls.length === 0) {
        return { content: [{ type: 'text', text: textOf(reply.content).trim() || '(The subagent gave no answer.)' }] }
      }
      context.push({ role: 'user', content: await this.runCalls(calls, signal, true) })
      if (signal.aborted) return failure('Cancelled')
    }
  }

  private window(): number {
    return this.target().model.contextWindow || DEFAULT_WINDOW
  }

  /** Near the context limit the model writes a summary, and the summary becomes the whole context. */
  private async compactIfNeeded(instructions: string, signal: AbortSignal): Promise<void> {
    if (this.context.length === 0 || this.used < this.window() * COMPACT_AT) return
    await this.compact(instructions, signal, '')
  }

  /** The model writes a summary, which becomes the whole context. False when it wrote none. */
  private async compact(instructions: string, signal: AbortSignal, focus: string): Promise<boolean> {
    this.update({ sessionUpdate: 'auto_compact_started', tokens_used: this.used, context_window: this.window() })
    const text = focus ? `${SUMMARY_PROMPT}\n\nWhat the user asks of this summary: ${focus}` : SUMMARY_PROMPT
    const ask: Message = { role: 'user', content: [{ type: 'text', text }] }
    const reply = await this.callModel(instructions, [...this.context, ask], signal, QUIET)
    const summary = textOf(reply.content).trim()
    if (summary) {
      this.context = [{ role: 'user', content: [{ type: 'text', text: SUMMARY_HEAD + summary }] }]
      this.record({ type: 'compact', summary })
      this.used = estimate(this.context)
    } else {
      this.host.log(`session ${this.id}: the model gave no summary, the context was not compacted`)
    }
    this.update({ sessionUpdate: 'auto_compact_completed', tokens_after: this.used })
    return Boolean(summary)
  }

  /** The `/compact` command: compact now and say so in one line. Neither goes to the model or the transcript. */
  private async compactNow(focus: string, signal: AbortSignal): Promise<string> {
    const say = (text: string): void => this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    try {
      if (this.context.length === 0) {
        say('There is nothing to compact yet.')
        return 'end_turn'
      }
      const before = this.used
      const done = await this.compact(await this.instructions(), signal, focus)
      this.update({ sessionUpdate: 'usage_update', used: this.used, size: this.window() })
      say(
        done
          ? `Compacted the conversation from ${before} to ${this.used} tokens.`
          : 'The model wrote no summary, so the conversation was not compacted.'
      )
      return 'end_turn'
    } catch (error) {
      if (signal.aborted) return 'cancelled'
      throw error
    }
  }

  private async allowed(shown: Shown, signal: AbortSignal): Promise<boolean> {
    const cancelled = new Promise<null>((done) => signal.addEventListener('abort', () => done(null), { once: true }))
    const answer = (await Promise.race([
      this.host.permission(this.id, shown).catch(() => null),
      cancelled
    ])) as { outcome?: { outcome?: unknown; optionId?: unknown } } | null
    return answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow_once'
  }

  private async runCall(call: ToolCallBlock, signal: AbortSignal, nested: boolean): Promise<ToolResultBlock> {
    const tool = this.offered(nested).find((item) => item.spec.name === call.name)
    const context = {
      cwd: this.cwd,
      env: this.env,
      signal,
      plan: (entries: Array<{ content: string; status: string }>): void =>
        this.update({ sessionUpdate: 'plan', entries: entries.map((entry) => ({ ...entry, priority: 'medium' })) })
    }
    const answer = (result: ToolResult): ToolResultBlock => ({
      type: 'tool_result',
      id: call.id,
      content: result.content,
      ...(result.isError ? { isError: true } : {})
    })
    const attempt = async (input: Record<string, unknown>): Promise<ToolResult> => {
      if (signal.aborted) return failure('Cancelled')
      try {
        return await tool!.run(input, context)
      } catch (error) {
        return failure(signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error))
      }
    }
    if (tool?.hidden && !call.error) return answer(await attempt(call.input))

    const shown = describe(call, tool, this.cwd, `call-${++this.callCount}`)
    const head = { toolCallId: shown.toolCallId, name: shown.name, title: shown.title, kind: shown.kind }
    this.update({ sessionUpdate: 'tool_call', ...shown, status: 'pending' })
    let result: ToolResult
    if (call.error) result = failure(call.error)
    else if (!tool) {
      const known = this.allTools(nested).some((item) => item.spec.name === call.name)
      result = failure(known ? `The tool ${call.name} is not available in ${this.mode} mode.` : `There is no tool named ${call.name}.`)
    } else if (signal.aborted) result = failure('Cancelled')
    else if (tool.asks && !(await this.allowed(shown, signal))) result = failure(signal.aborted ? 'Cancelled' : REFUSED)
    else {
      this.update({ sessionUpdate: 'tool_call_update', ...head, status: 'in_progress' })
      result = await attempt(shown.rawInput)
    }
    this.update({
      sessionUpdate: 'tool_call_update',
      ...head,
      status: result.isError ? 'failed' : 'completed',
      content: shownContent(result),
      rawOutput: { output: textOf(result.content) }
    })
    return answer(result)
  }

  /** Rebuild the context from a transcript and send the app every stored message. */
  private replay(stored: string): void {
    const messages: Message[] = []
    for (const line of stored.split('\n')) {
      if (!line.trim()) continue
      let entry: { type?: string; message?: Message; summary?: string }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (entry.type === 'compact' && typeof entry.summary === 'string') {
        this.context = [{ role: 'user', content: [{ type: 'text', text: SUMMARY_HEAD + entry.summary }] }]
      } else if (entry.type === 'message' && entry.message && Array.isArray(entry.message.content)) {
        messages.push(entry.message)
        this.context.push(entry.message)
      }
    }

    const results = new Map<string, ToolResultBlock>()
    for (const message of messages) {
      for (const block of message.content) if (block.type === 'tool_result') results.set(block.id, block)
    }
    const tools = this.allTools()
    // Paragraphs between the model calls of a turn, as the turn showed them.
    let shown = { text: false, thought: false }
    for (const message of messages) {
      const fresh = { text: true, thought: true }
      const lead = (kind: 'text' | 'thought'): string => {
        const value = fresh[kind] && shown[kind] ? '\n\n' : ''
        fresh[kind] = false
        shown[kind] = true
        return value
      }
      for (const block of message.content) {
        if (block.type === 'text' && block.text && message.role === 'user') {
          shown = { text: false, thought: false }
          this.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: block.text } })
        } else if (block.type === 'text' && block.text) {
          this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: lead('text') + block.text } })
        } else if (block.type === 'thinking' && block.text) {
          this.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: lead('thought') + block.text } })
        } else if (block.type === 'tool_call') {
          this.replayCall(block, tools, results.get(block.id))
        }
      }
    }

    // A turn that was cut off left calls without results; the model's API takes no such history.
    const last = this.context.at(-1)
    const open = last?.role === 'assistant' ? last.content.filter((block) => block.type === 'tool_call') : []
    if (open.length > 0) {
      this.push({
        role: 'user',
        content: open.map((call) => ({ type: 'tool_result', id: call.id, content: [{ type: 'text', text: 'Interrupted' }], isError: true }))
      })
    }
    this.used = estimate(this.context)
  }

  private replayCall(call: ToolCallBlock, tools: Tool[], result: ToolResultBlock | undefined): void {
    const tool = tools.find((item) => item.spec.name === call.name)
    if (tool?.hidden && !call.error) {
      try {
        const entries = planEntries(call.input).map((entry) => ({ ...entry, priority: 'medium' }))
        this.update({ sessionUpdate: 'plan', entries })
      } catch {
        // a plan the model sent in a wrong shape was never shown
      }
      return
    }
    const shown = describe(call, tool, this.cwd, `call-${++this.callCount}`)
    const done: ToolResult = result ?? failure('Interrupted')
    this.update({
      sessionUpdate: 'tool_call',
      ...shown,
      status: done.isError ? 'failed' : 'completed',
      content: shownContent({ ...done, diff: done.isError ? undefined : storedDiff(shown) }),
      rawOutput: { output: textOf(done.content) }
    })
  }
}

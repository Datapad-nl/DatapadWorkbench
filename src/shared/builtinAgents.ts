/**
 * An agent Claude Code started itself with its Agent tool, inside one chat. It has no chat
 * of its own: what is known about it comes from the tool calls in the parent chat's stream.
 */
export type BuiltinAgent = {
  /** The id of the Agent tool call that started it. */
  id: string
  title: string
  model: string | null
  /** The prompt the orchestrator gave it. */
  task: string
  /** A background agent keeps running after its tool call returns. */
  background: boolean
  status: 'running' | 'done' | 'error' | 'stopped'
  /** The title of its latest tool call. */
  doing: string
  report: string
  startedAt: string
}

export type BuiltinAgentsFeed = { chatId: string; agents: BuiltinAgent[] }

/** The most agents kept per chat. The oldest go first. */
export const MAX_BUILTIN_AGENTS = 12

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return value && typeof value === 'object' ? (value as Fields) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The last text block of a tool result. */
function lastText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (
    content
      .map((block) => text(fields(block).text))
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

/**
 * Applies one `tool_call` or `tool_call_update` of the parent chat to its agents.
 * Returns the same array when the update is not about an agent.
 */
export function applyToolUpdate(agents: BuiltinAgent[], update: unknown, now: string): BuiltinAgent[] {
  const call = fields(update)
  const kind = text(call.sessionUpdate)
  const id = text(call.toolCallId)
  if (!id || (kind !== 'tool_call' && kind !== 'tool_call_update')) return agents
  const meta = fields(fields(call._meta).claudeCode)

  // A tool call made by an agent says what that agent is doing now.
  const parentId = text(meta.parentToolUseId)
  if (parentId) {
    const doing = text(call.title)
    const parent = agents.find((agent) => agent.id === parentId)
    if (!parent || parent.status !== 'running' || !doing || parent.doing === doing) return agents
    return agents.map((agent) => (agent === parent ? { ...agent, doing } : agent))
  }

  if (meta.toolName !== 'Agent' && meta.toolName !== 'Task') return agents
  const before = agents.find((agent) => agent.id === id)
  const next: BuiltinAgent = before
    ? { ...before }
    : {
        id,
        title: 'Agent',
        model: null,
        task: '',
        background: false,
        status: 'running',
        doing: '',
        report: '',
        startedAt: now
      }

  const input = fields(call.rawInput)
  if (text(input.description)) next.title = text(input.description)
  if (text(input.prompt)) next.task = text(input.prompt)
  if (text(input.model) && !next.model) next.model = text(input.model)
  if (input.run_in_background === true) next.background = true

  const response = fields(meta.toolResponse)
  if (text(response.resolvedModel)) next.model = text(response.resolvedModel)
  if (response.status === 'async_launched') next.background = true
  if (response.status === 'completed') {
    next.status = 'done'
    next.report = lastText(response.content)
  }

  // The tool call of a background agent completes when the agent is launched, not when it is done.
  if (call.status === 'completed' && !next.background) next.status = 'done'
  if (call.status === 'failed') {
    next.status = 'error'
    next.report = lastText(call.rawOutput)
  }

  const rest = before ? agents.map((agent) => (agent === before ? next : agent)) : [...agents, next]
  return rest.slice(-MAX_BUILTIN_AGENTS)
}

/** Applies Claude Code's notice that a background agent ended. */
export function applyTaskNotification(agents: BuiltinAgent[], message: unknown): BuiltinAgent[] {
  const notice = fields(message)
  const id = text(notice.tool_use_id)
  if (!agents.some((agent) => agent.id === id)) return agents
  const status = notice.status === 'completed' ? 'done' : notice.status === 'failed' ? 'error' : 'stopped'
  return agents.map((agent) => (agent.id === id ? { ...agent, status, report: text(notice.summary) } : agent))
}

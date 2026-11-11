import { describe, expect, it } from 'vitest'
import {
  MAX_BUILTIN_AGENTS,
  applyTaskNotification,
  applyToolUpdate,
  endForegroundAgents,
  runningAdmitted,
  type BuiltinAgent
} from './builtinAgents'

const NOW = '2026-11-11T12:00:00.000Z'

function run(updates: unknown[], start: BuiltinAgent[] = []): BuiltinAgent[] {
  return updates.reduce<BuiltinAgent[]>((agents, update) => applyToolUpdate(agents, update, NOW), start)
}

const agentCall = (id: string, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): unknown => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  _meta: { claudeCode: { toolName: 'Agent', ...meta } },
  ...extra
})

const started = [
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'a1',
    title: 'Task',
    rawInput: {},
    _meta: { claudeCode: { toolName: 'Agent' } }
  },
  agentCall('a1', { rawInput: { description: 'Echo test', prompt: 'Run echo hello', model: 'haiku' } })
]

describe('applyToolUpdate', () => {
  it('adds an agent when Claude Code calls its Agent tool', () => {
    expect(run(started)).toEqual([
      {
        id: 'a1',
        title: 'Echo test',
        model: 'haiku',
        task: 'Run echo hello',
        background: false,
        status: 'running',
        doing: '',
        report: '',
        startedAt: NOW
      }
    ])
  })

  it('finishes a foreground agent with its last text as the report', () => {
    const [agent] = run([
      ...started,
      agentCall(
        'a1',
        {},
        {
          toolResponse: {
            status: 'completed',
            resolvedModel: 'claude-haiku-5-5',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'hello' }
            ]
          }
        }
      ),
      agentCall('a1', { status: 'completed' })
    ])
    expect(agent).toMatchObject({ status: 'done', report: 'hello', model: 'claude-haiku-5-5' })
  })

  it('keeps a background agent running after its tool call completes', () => {
    const [agent] = run([
      ...started,
      agentCall('a1', {}, { toolResponse: { status: 'async_launched', resolvedModel: 'claude-haiku-5-5' } }),
      agentCall('a1', { status: 'completed', rawOutput: [{ type: 'text', text: 'Async agent launched' }] })
    ])
    expect(agent).toMatchObject({ status: 'running', background: true, report: '' })
  })

  it('shows the latest tool call of an agent as what it is doing', () => {
    const child = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'echo hello',
      _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'a1' } }
    }
    const agents = run([...started, child])
    expect(agents).toHaveLength(1)
    expect(agents[0].doing).toBe('echo hello')
  })

  it('fails an agent whose tool call failed', () => {
    const [agent] = run([...started, agentCall('a1', { status: 'failed', rawOutput: 'No such agent type' })])
    expect(agent).toMatchObject({ status: 'error', report: 'No such agent type' })
  })

  it('leaves the agents alone for other tool calls', () => {
    const agents = run(started)
    const other = {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'ls',
      _meta: { claudeCode: { toolName: 'Bash' } }
    }
    expect(applyToolUpdate(agents, other, NOW)).toBe(agents)
    expect(applyToolUpdate(agents, { sessionUpdate: 'agent_message_chunk' }, NOW)).toBe(agents)
  })

  it('drops the oldest agents past the limit', () => {
    const many = Array.from({ length: MAX_BUILTIN_AGENTS + 2 }, (_, index) => agentCall(`a${index}`))
    const agents = run(many)
    expect(agents).toHaveLength(MAX_BUILTIN_AGENTS)
    expect(agents[0].id).toBe('a2')
  })
})

describe('applyTaskNotification', () => {
  const running = run([...started, agentCall('a1', {}, { toolResponse: { status: 'async_launched' } })])

  it('finishes a background agent with the summary as its report', () => {
    const [agent] = applyTaskNotification(running, { tool_use_id: 'a1', status: 'completed', summary: 'hello' })
    expect(agent).toMatchObject({ status: 'done', report: 'hello' })
  })

  it('marks a stopped agent', () => {
    expect(applyTaskNotification(running, { tool_use_id: 'a1', status: 'stopped' })[0].status).toBe('stopped')
  })

  it('ignores a notice about an unknown task', () => {
    expect(applyTaskNotification(running, { tool_use_id: 'zz', status: 'completed' })).toBe(running)
  })
})

describe('endForegroundAgents', () => {
  const agent = (id: string, extra: Partial<BuiltinAgent>): BuiltinAgent => ({ id, ...extra }) as BuiltinAgent

  it('stops the foreground agents that still run, and leaves the rest', () => {
    const agents = [
      agent('fore', { status: 'running', background: false }),
      agent('back', { status: 'running', background: true }),
      agent('done', { status: 'done', background: false })
    ]
    expect(endForegroundAgents(agents).map((item) => item.status)).toEqual(['stopped', 'running', 'done'])
    const settled = agents.slice(1)
    expect(endForegroundAgents(settled)).toBe(settled)
  })
})

describe('runningAdmitted', () => {
  const agent = (id: string, status: BuiltinAgent['status']): BuiltinAgent => ({ id, status }) as BuiltinAgent

  it('counts the calls let through that still run, not the ones the stream only shows', () => {
    const admitted = new Map([['a1', 0], ['a2', 0]])
    const agents = [agent('a1', 'running'), agent('a2', 'done'), agent('a3', 'running')]
    expect(runningAdmitted(agents, admitted, 1_000)).toBe(1)
    expect([...admitted.keys()]).toEqual(['a1'])
  })

  it('counts a call the stream does not show for a minute, then forgets it', () => {
    const admitted = new Map([['gone', 0]])
    expect(runningAdmitted([], admitted, 59_000)).toBe(1)
    expect(runningAdmitted([], admitted, 61_000)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { isToolAllowed, mcpServerTool, toolCallName, toolsForAgent } from './botTools'

describe('bot tools', () => {
  it('renames the tools for the other agent and keeps the rest', () => {
    expect(toolsForAgent(['Read', 'Bash', 'WebSearch', 'mcp__browser', 'Custom'], 'claude', 'grok')).toEqual([
      'read_file',
      'run_terminal_command',
      'WebSearch',
      'mcp__browser',
      'Custom'
    ])
    expect(toolsForAgent(['read_file', 'image_gen'], 'grok', 'claude')).toEqual(['Read', 'image_gen'])
    expect(toolsForAgent(['Read', 'read_file'], 'claude', 'grok')).toEqual(['read_file'])
  })

  it('names every tool of an MCP server', () => {
    expect(mcpServerTool('github')).toBe('mcp__github')
  })

  it('reads the tool name each agent gives a tool call', () => {
    expect(toolCallName({ _meta: { claudeCode: { toolName: 'Bash' } } })).toBe('Bash')
    expect(toolCallName({ _meta: { 'x.ai/tool': { name: 'run_terminal_command' } } })).toBe('run_terminal_command')
    expect(
      toolCallName({
        _meta: { 'x.ai/tool': { name: 'use_tool' } },
        rawInput: { tool_name: 'github__create_issue', tool_input: {} }
      })
    ).toBe('mcp__github__create_issue')
    expect(toolCallName({ rawInput: { command: 'ls' } })).toBeNull()
    expect(toolCallName(undefined)).toBeNull()
  })

  it('allows a tool by its name or its whole MCP server', () => {
    const allowed = ['Read', 'mcp__browser', 'mcp__github__create_issue']
    expect(isToolAllowed(allowed, 'Read')).toBe(true)
    expect(isToolAllowed(allowed, 'mcp__browser__navigate')).toBe(true)
    expect(isToolAllowed(allowed, 'mcp__github__create_issue')).toBe(true)
    expect(isToolAllowed(allowed, 'mcp__github__delete_repo')).toBe(false)
    expect(isToolAllowed(allowed, 'mcp__browser2__navigate')).toBe(false)
    expect(isToolAllowed(allowed, 'Bash')).toBe(false)
  })
})

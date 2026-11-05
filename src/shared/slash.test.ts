import { describe, expect, it } from 'vitest'
import { filterSlashCommands, parseSlashLine, slashCommandsFor } from './slash'

const ids = (agent: 'grok' | 'claude', announced = []) => slashCommandsFor(agent, announced).map((def) => def.id)

describe('slashCommandsFor', () => {
  it('keeps Grok-only commands out of Claude chats', () => {
    expect(ids('grok')).toEqual(expect.arrayContaining(['imagine', 'login', 'docs']))
    expect(ids('claude')).not.toEqual(expect.arrayContaining(['imagine']))
    expect(ids('claude')).not.toContain('login')
    expect(ids('claude')).not.toContain('docs')
  })

  it('leaves Grok memory, workflow and terminal commands out of Claude chats', () => {
    for (const id of ['memory', 'flush', 'dream', 'feedback', 'doctor', 'workflows', 'vim-mode']) {
      expect(ids('grok')).toContain(id)
      expect(ids('claude')).not.toContain(id)
    }
    expect(slashCommandsFor('claude', []).some((def) => def.kind === 'unavailable')).toBe(false)
  })

  it("offers Claude Code's own /loop and /goal instead of the Grok prompts", () => {
    const list = slashCommandsFor('claude', [{ name: 'loop', description: 'Run on an interval' }])
    expect(list.filter((def) => def.id === 'loop')).toEqual([expect.objectContaining({ kind: 'agent' })])
    expect(ids('claude')).not.toContain('goal')
  })

  it("uses the agent's own version over our prompt", () => {
    const list = slashCommandsFor('claude', [{ name: 'compact', description: 'Clear history but keep a summary' }])
    const compact = list.filter((def) => def.id === 'compact')
    expect(compact).toHaveLength(1)
    expect(compact[0]).toMatchObject({ kind: 'agent', hint: 'Clear history but keep a summary' })
  })

  it('keeps our local commands when the agent announces the same name', () => {
    const list = slashCommandsFor('claude', [{ name: 'export', description: 'Their export' }])
    expect(list.filter((def) => def.id === 'export')).toEqual([expect.objectContaining({ kind: 'local' })])
  })

  it('appends announced commands, skipping names our ids or aliases already use', () => {
    const list = slashCommandsFor('claude', [
      { name: 'context', description: 'Show context usage', hint: 'detail' },
      { name: 'clear', description: 'Clear the conversation' }
    ])
    expect(list.find((def) => def.id === 'context')).toMatchObject({
      kind: 'agent',
      hint: 'Show context usage · detail'
    })
    expect(list.find((def) => def.id === 'clear')).toBeUndefined()
  })
})

describe('parseSlashLine', () => {
  it('finds a command by id or alias and splits off the arguments', () => {
    expect(parseSlashLine('/rename  New title ')).toMatchObject({ name: 'rename', args: 'New title' })
    expect(parseSlashLine('/title x')?.def?.id).toBe('rename')
  })

  it('looks in the list it is given', () => {
    const list = slashCommandsFor('claude', [{ name: 'security-review', description: 'Review security' }])
    expect(parseSlashLine('/security-review', list)?.def?.kind).toBe('agent')
    expect(parseSlashLine('/security-review')?.def).toBeNull()
  })

  it('ignores text that is not a command', () => {
    expect(parseSlashLine('hello /new')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('ranks an exact id first and unavailable commands last', () => {
    expect(filterSlashCommands('new')[0].id).toBe('new')
    const all = filterSlashCommands('')
    expect(all.at(-1)?.kind).toBe('unavailable')
  })
})

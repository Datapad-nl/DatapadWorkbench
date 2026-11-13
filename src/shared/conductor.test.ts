import { describe, expect, it } from 'vitest'
import {
  MAX_NUDGES,
  agentToolRule,
  conductorPrompt,
  conductorRule,
  isFileEditTool,
  normalizeMaxSubagents
} from './conductor'

describe('conductorPrompt', () => {
  it('lets the conductor pick a model per worker when Settings fixes none', () => {
    const prompt = conductorPrompt('  move the store to SQLite ', '', 4)
    expect(prompt).toContain('`haiku` when a small, fast model is enough')
    expect(prompt).toContain('`fable` for a really hard task')
    expect(prompt.endsWith('The job:\nmove the store to SQLite')).toBe(true)
  })

  it('names the model Settings fixes for every worker', () => {
    const prompt = conductorPrompt('ship it', 'opus', 4)
    expect(prompt).toContain('Every worker runs on opus')
    expect(prompt).not.toContain('haiku')
  })

  it('tells the conductor how many workers may run at once', () => {
    expect(conductorPrompt('ship it', '', 3)).toContain('At most 3 workers run at the same time')
    expect(conductorPrompt('ship it', '', 1)).toContain('At most 1 worker runs at the same time')
  })

  it('keeps the conductor off the work and has it check each task against its spec', () => {
    const rule = conductorRule('', 4)
    expect(rule).toContain('You do not write code or change files yourself')
    expect(rule).toContain('acceptance criteria')
    expect(rule).toContain('criterion by criterion')
    expect(rule).toContain(`After ${MAX_NUDGES} nudges on the same failed criterion`)
    expect(conductorPrompt('ship it', '', 4).startsWith(rule)).toBe(true)
  })
})

describe('isFileEditTool', () => {
  it('names the Claude Code tools that change files', () => {
    for (const name of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(isFileEditTool(name)).toBe(true)
    for (const name of ['Read', 'Bash', 'Agent', undefined]) expect(isFileEditTool(name)).toBe(false)
  })
})

describe('normalizeMaxSubagents', () => {
  it('keeps a whole number from 1 to 10 and falls back to 4', () => {
    expect(normalizeMaxSubagents(6)).toBe(6)
    expect(normalizeMaxSubagents(0)).toBe(1)
    expect(normalizeMaxSubagents(99)).toBe(10)
    expect(normalizeMaxSubagents(undefined)).toBe(4)
    expect(normalizeMaxSubagents('3')).toBe(4)
  })
})

describe('agentToolRule', () => {
  it('tells Claude Code when to start an agent without being asked', () => {
    for (const rule of [agentToolRule('', 2), agentToolRule('opus', 2)]) {
      expect(rule).toContain('without being asked')
      expect(rule).toContain('in the same turn')
      expect(rule).toContain('review the diff')
    }
  })

  it('has Claude Code pick a model per agent when Settings fixes none', () => {
    const rule = agentToolRule('', 3)
    expect(rule).toContain('`haiku` when a small, fast model is enough')
    expect(rule).toContain('`fable` for a really hard task')
    expect(rule).toContain('At most 3 of your agents run at the same time')
  })

  it('names the model Settings fixes for every agent', () => {
    const rule = agentToolRule('claude-haiku-4-5', 1)
    expect(rule).toContain('run on claude-haiku-4-5')
    expect(rule).not.toContain('`sonnet`')
    expect(rule).toContain('At most 1 of your agents runs at the same time')
  })
})

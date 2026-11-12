import { describe, expect, it } from 'vitest'
import { contextFromUpdate, contextLabel, handoffAdvised, handoffOpening, handoffPrompt } from './handoff'

describe('contextFromUpdate', () => {
  it("reads Claude Code's usage_update", () => {
    expect(contextFromUpdate({ sessionUpdate: 'usage_update', used: 84_000, size: 200_000 })).toEqual({
      used: 84_000,
      size: 200_000
    })
  })

  it("averages Grok Build's turn input over its model calls and keeps the known window", () => {
    const before = { used: 1, size: 256_000 }
    const update = { sessionUpdate: 'turn_completed', usage: { inputTokens: 4_164_612, modelCalls: 20 } }
    expect(contextFromUpdate(update, before)).toEqual({ used: 208_231, size: 256_000, estimate: true })
  })

  it('takes the window from an auto-compact notice and the size after it', () => {
    const started = contextFromUpdate({
      sessionUpdate: 'auto_compact_started',
      tokens_used: 222_720,
      context_window: 256_000
    })
    expect(started).toEqual({ used: 222_720, size: 256_000 })
    expect(contextFromUpdate({ sessionUpdate: 'auto_compact_completed', tokens_after: 21_488 }, started!)).toEqual({
      used: 21_488,
      size: 256_000
    })
  })

  it('ignores updates without usable numbers', () => {
    expect(contextFromUpdate({ sessionUpdate: 'agent_message_chunk' })).toBeNull()
    expect(contextFromUpdate({ sessionUpdate: 'turn_completed', usage: { inputTokens: 900, modelCalls: 0 } })).toBeNull()
    expect(contextFromUpdate({ sessionUpdate: 'usage_update', used: Number.NaN })).toBeNull()
  })
})

describe('handoffAdvised', () => {
  it('advises past 60% of a known window or 120k tokens', () => {
    expect(handoffAdvised({ used: 110_000, size: 200_000 })).toBe(false)
    expect(handoffAdvised({ used: 120_000, size: 200_000 })).toBe(true)
    expect(handoffAdvised({ used: 119_000, size: null })).toBe(false)
    expect(handoffAdvised({ used: 125_000, size: 1_000_000 })).toBe(true)
    expect(handoffAdvised(undefined)).toBe(false)
  })
})

describe('contextLabel', () => {
  it('shows a share of a known window and tokens otherwise, marking estimates', () => {
    expect(contextLabel({ used: 124_000, size: 200_000 })).toBe('62%')
    expect(contextLabel({ used: 140_400, size: null, estimate: true })).toBe('~140k')
  })
})

describe('handoff texts', () => {
  it('passes the user note on to the new chat', () => {
    expect(handoffPrompt('  keep the tests green ')).toContain('The user adds, for the new chat: keep the tests green')
    expect(handoffPrompt('')).not.toContain('The user adds')
  })

  it('starts the new chat on the next step, or makes it wait', () => {
    const base = { fromTitle: 'Store', fromId: 'c1', file: '/h/c1.md', summary: '## Goal\nSQLite' }
    expect(handoffOpening({ ...base, next: 'run the migration' })).toContain('Start with this: run the migration')
    const waiting = handoffOpening({ ...base, next: ' ' })
    expect(waiting).toContain('wait for the user')
    expect(waiting).toContain('read_chat (chat id c1)')
  })
})

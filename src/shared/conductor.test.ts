import { describe, expect, it } from 'vitest'
import { conductorPrompt, normalizeMaxSubagents } from './conductor'

describe('conductorPrompt', () => {
  it('lets the conductor pick a model per worker when Settings fixes none', () => {
    const prompt = conductorPrompt('  move the store to SQLite ', '', 4)
    expect(prompt).toContain('`haiku` when a small, fast model is enough')
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

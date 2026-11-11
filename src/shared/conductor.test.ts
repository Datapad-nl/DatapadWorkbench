import { describe, expect, it } from 'vitest'
import { conductorPrompt } from './conductor'

describe('conductorPrompt', () => {
  it('lets the conductor pick a model per worker when Settings fixes none', () => {
    const prompt = conductorPrompt('  move the store to SQLite ', '')
    expect(prompt).toContain('`haiku` when a small, fast model is enough')
    expect(prompt.endsWith('The job:\nmove the store to SQLite')).toBe(true)
  })

  it('names the model Settings fixes for every worker', () => {
    const prompt = conductorPrompt('ship it', 'opus')
    expect(prompt).toContain('Every worker runs on opus')
    expect(prompt).not.toContain('haiku')
  })
})

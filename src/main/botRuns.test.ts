import { describe, expect, it } from 'vitest'
import { botRun, endBotRun, isBotRun, startBotRun } from './botRuns'

describe('bot runs', () => {
  it('ends only the run it was started as, not a later one in the same chat', () => {
    const first = startBotRun('c1', { botId: 'scout', kind: 'schedule' })
    const second = startBotRun('c1', { botId: 'scout', kind: 'followUp', note: 'check' })
    expect(endBotRun('c1', first)).toBe(false)
    expect(botRun('c1')).toBe(second)
    expect(endBotRun('c1', second)).toBe(true)
    expect(isBotRun('c1')).toBe(false)
    startBotRun('c1', { botId: 'scout', kind: 'schedule' })
    // A deleted chat ends whatever runs in it.
    expect(endBotRun('c1')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { STEP_BREAK, plainReply, replySteps } from './steps'

describe('replySteps', () => {
  it('keeps a reply without breaks whole', () => {
    expect(replySteps('One paragraph.\n\nAnother.')).toEqual(['One paragraph.\n\nAnother.'])
  })

  it('cuts at each break and drops empty parts', () => {
    const text = `Reading the file.${STEP_BREAK}${STEP_BREAK}Now the edits:${STEP_BREAK}Done.\n\nAll tests pass.`
    expect(replySteps(text)).toEqual(['Reading the file.', 'Now the edits:', 'Done.\n\nAll tests pass.'])
  })
})

describe('plainReply', () => {
  it('turns breaks into paragraph breaks', () => {
    expect(plainReply(`First.${STEP_BREAK}Second.`)).toBe('First.\n\nSecond.')
  })

  it('leaves other text untouched', () => {
    expect(plainReply('  as is  ')).toBe('  as is  ')
  })
})

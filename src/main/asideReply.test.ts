import { describe, expect, it } from 'vitest'
import { asideEndReply, parseAsideReply } from './asideReply'

describe('parseAsideReply', () => {
  it('reads a STEER header', () => {
    expect(parseAsideReply('STEER\n\nUse tabs.')).toEqual({ steer: true, reply: 'Use tabs.' })
    expect(parseAsideReply(' Paris. ')).toEqual({ steer: false, reply: 'Paris.' })
  })
})

describe('asideEndReply', () => {
  it('keeps the answer an aside streamed before it was stopped', () => {
    expect(asideEndReply('The capital of France is Paris.', new Error('cancelled'), 'x')).toEqual({
      steer: false,
      reply: 'The capital of France is Paris.'
    })
  })

  it('says stopped when nothing came yet', () => {
    expect(asideEndReply('  ', new Error('cancelled'), 'x')).toEqual({ steer: false, reply: '(stopped)' })
  })

  it('shows the failure when an aside fails without text', () => {
    expect(asideEndReply('', new Error('401 No auth'), '401 No auth')).toEqual({ steer: false, reply: '401 No auth' })
  })
})

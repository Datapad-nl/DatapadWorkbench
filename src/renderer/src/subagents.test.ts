import { describe, expect, it } from 'vitest'
import { builtinAgentState, workerState, workersSummary } from './subagents'

describe('workerState', () => {
  it('puts a waiting question before the running turn', () => {
    expect(workerState({ status: 'streaming', needsUser: true, messageCount: 1 })).toBe('needs-you')
  })

  it('is working while its turn runs', () => {
    expect(workerState({ status: 'streaming', needsUser: false, messageCount: 1 })).toBe('working')
  })

  it('is failed when the turn ended in an error', () => {
    expect(workerState({ status: 'error', needsUser: false, messageCount: 1 })).toBe('error')
  })

  it('has reported back once the task has an answer', () => {
    expect(workerState({ status: 'idle', needsUser: false, messageCount: 2 })).toBe('reported')
    expect(workerState({ status: undefined, needsUser: false, messageCount: 4 })).toBe('reported')
  })

  it('has not started without an answer', () => {
    expect(workerState({ status: undefined, needsUser: false, messageCount: 0 })).toBe('waiting')
  })
})

describe('builtinAgentState', () => {
  it('follows the status of the agent', () => {
    expect(builtinAgentState({ status: 'done', background: false }, true)).toBe('reported')
    expect(builtinAgentState({ status: 'error', background: true }, false)).toBe('error')
    expect(builtinAgentState({ status: 'stopped', background: true }, false)).toBe('stopped')
  })

  it('keeps a background agent working after the turn that started it', () => {
    expect(builtinAgentState({ status: 'running', background: true }, false)).toBe('working')
  })

  it('stops a foreground agent with the turn that started it', () => {
    expect(builtinAgentState({ status: 'running', background: false }, true)).toBe('working')
    expect(builtinAgentState({ status: 'running', background: false }, false)).toBe('stopped')
  })
})

describe('workersSummary', () => {
  it('counts each state that has a worker', () => {
    expect(workersSummary(['working', 'reported', 'working', 'needs-you'])).toBe(
      '1 needs you · 2 working · 1 reported back'
    )
  })

  it('says nothing without workers', () => {
    expect(workersSummary([])).toBe('')
  })
})

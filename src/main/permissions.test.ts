import { afterEach, describe, expect, it } from 'vitest'
import {
  askPermission,
  bindPermissionSession,
  cancelAllPermissions,
  cancelChatPermissions,
  clearSessionStopped,
  forgetChatSessions,
  isPlanGateText,
  isSessionStopped,
  markSessionStopped,
  onPermissionSettled,
  pendingPermissionRequests,
  resolvePermission
} from './permissions'
import {
  askUserQuestions,
  cancelAgentQuestions,
  cancelChatQuestions,
  pendingQuestionRequests
} from './questions'

const options = [
  { optionId: 'yes', kind: 'allow_once' },
  { optionId: 'no', kind: 'reject_once' }
]

afterEach(() => {
  cancelAllPermissions()
  cancelAgentQuestions()
  cancelChatQuestions('chat-1')
  forgetChatSessions('chat-1')
})

describe('isPlanGateText', () => {
  it('matches the ways agents name the plan gates', () => {
    for (const text of ['Exit plan mode', 'exit_plan_mode', 'Plan: enter', 'enter-plan', 'switch_mode exit plan']) {
      expect(isPlanGateText(text)).toBe(true)
    }
  })

  it('leaves other tools alone', () => {
    for (const text of ['Explain the plan', 'planning exit strategy', 'exit planner', 'Edit plan.md']) {
      expect(isPlanGateText(text)).toBe(false)
    }
  })
})

describe('askPermission', () => {
  it('refuses a tool when no chat can be asked, and leaves nothing waiting', async () => {
    const outcome = await askPermission('r1', 'unbound-session', { options })
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(pendingPermissionRequests()).toEqual([])
  })

  it('cancels when no chat can be asked and there is no reject option', async () => {
    const outcome = await askPermission('r1', 'unbound-session', { options: [{ optionId: 'yes', kind: 'allow_once' }] })
    expect(outcome).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('keeps every request of a chat waiting until each is answered', async () => {
    bindPermissionSession('s1', 'chat-1', 'ask')
    const settled: string[] = []
    const off = onPermissionSettled((request) => settled.push(request.requestId))
    const first = askPermission('r1', 's1', { options, toolCall: { title: 'Edit a.ts' } })
    const second = askPermission('r2', 's1', { options, toolCall: { title: 'Edit b.ts' } })
    expect(pendingPermissionRequests().map((request) => request.requestId)).toEqual(['r1', 'r2'])

    expect(resolvePermission('r1', 'allow')).toBe(true)
    await expect(first).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    expect(pendingPermissionRequests().map((request) => request.requestId)).toEqual(['r2'])

    cancelChatPermissions('chat-1')
    await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(settled).toEqual(['r1', 'r2'])
    off()
  })
})

describe('stopped sessions', () => {
  it('stay stopped until the next turn clears them or the chat is forgotten', () => {
    bindPermissionSession('s1', 'chat-1', 'ask')
    markSessionStopped('s1')
    expect(isSessionStopped('s1')).toBe(true)
    clearSessionStopped('s1')
    expect(isSessionStopped('s1')).toBe(false)

    markSessionStopped('s1')
    forgetChatSessions('chat-1')
    expect(isSessionStopped('s1')).toBe(false)
    expect(isSessionStopped('')).toBe(false)
  })
})

describe('cancelling questions', () => {
  it('keeps intake questions when a turn is stopped, and cancels them when the chat goes', async () => {
    const agentAsk = askUserQuestions('q1', 's1', [], 'ext', { chatId: 'chat-1' })
    const intakeAsk = askUserQuestions('q2', 'intake:chat-1', [], 'ext', { chatId: 'chat-1' })

    cancelChatQuestions('chat-1', { keepIntake: true })
    await expect(agentAsk).resolves.toEqual({ type: 'SkipInterview' })
    expect(pendingQuestionRequests().map((request) => request.requestId)).toEqual(['q2'])

    cancelAgentQuestions()
    expect(pendingQuestionRequests().map((request) => request.requestId)).toEqual(['q2'])

    cancelChatQuestions('chat-1')
    await expect(intakeAsk).resolves.toEqual({ type: 'SkipInterview' })
    expect(pendingQuestionRequests()).toEqual([])
  })
})

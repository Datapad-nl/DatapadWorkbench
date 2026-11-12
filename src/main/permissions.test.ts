import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askPermission,
  bindPermissionSession,
  cancelAllPermissions,
  cancelChatPermissions,
  clearSessionStopped,
  findClash,
  forgetChatSessions,
  isPlanGateText,
  isSessionStopped,
  markSessionStopped,
  outcomeFor,
  onPermissionSettled,
  onPermissionUpdated,
  pendingPermissionRequests,
  resolvePermission,
  setEditGuard
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

describe('outcomeFor', () => {
  it('answers for this call only, so the agent asks again next time', () => {
    const offered = [
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'never', kind: 'reject_always' },
      { optionId: 'not-now', kind: 'reject_once' }
    ]
    expect(outcomeFor(offered, 'allow')).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(outcomeFor(offered, 'deny')).toEqual({ outcome: { outcome: 'selected', optionId: 'not-now' } })
    expect(outcomeFor([{ optionId: 'always', kind: 'allow_always' }], 'allow')).toEqual({
      outcome: { outcome: 'selected', optionId: 'always' }
    })
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

describe('edits to files another chat holds', () => {
  const clash = { chatId: 'chat-2', chatTitle: 'Other', files: ['a.ts'], running: true }
  const edit = { options, toolCall: { kind: 'edit', title: 'Edit a.ts', locations: [{ path: '/p/a.ts' }] } }

  afterEach(() => vi.useRealTimers())

  it('asks the guard only for tools that change files', async () => {
    const find = vi.fn(async () => clash)
    setEditGuard({ find, isRunning: () => true })
    bindPermissionSession('s-1', 'chat-1', 'accept')
    expect(await findClash('s-1', { options, toolCall: { kind: 'read', title: 'Read a.ts' } })).toBeNull()
    expect(await findClash('s-1', edit)).toEqual(clash)
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('waits for the other chat to finish, then lets the edit through', async () => {
    vi.useFakeTimers()
    let running = true
    setEditGuard({ find: async () => clash, isRunning: () => running })
    bindPermissionSession('s-1', 'chat-1', 'accept')
    const updates: unknown[] = []
    const stop = onPermissionUpdated((request) => updates.push(request.clash))
    const answer = askPermission('r-wait', 's-1', edit, clash)

    expect(resolvePermission('r-wait', 'wait')).toBe(true)
    expect(updates).toEqual([{ ...clash, waiting: true }])
    expect(pendingPermissionRequests()[0].clash?.waiting).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(pendingPermissionRequests()).toHaveLength(1)

    running = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(await answer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } })
    stop()
  })

  it('does not wait on a card without a clash', () => {
    bindPermissionSession('s-1', 'chat-1', 'ask')
    void askPermission('r-plain', 's-1', edit)
    expect(resolvePermission('r-plain', 'wait')).toBe(false)
    expect(pendingPermissionRequests()).toHaveLength(1)
  })
})

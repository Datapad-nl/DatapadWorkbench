import { describe, expect, it } from 'vitest'
import { sdkSignal, selfTurnAction, type SelfTurnContext, type SelfTurnSignal } from './selfTurn'

const state = (value: string): unknown => ({ type: 'system', subtype: 'session_state_changed', state: value })
const result = (origin: string, turns = 2): unknown => ({
  type: 'result',
  subtype: 'success',
  origin: { kind: origin },
  num_turns: turns,
  is_error: false
})

/** One chat session, wired to the decisions the way grok.ts wires them. */
function session(claude = true) {
  let open: SelfTurnContext['open'] = 'none'
  let running = false
  let stopped = false
  let preparing = false
  let draft = ''
  const messages: string[] = []
  const opened: Array<'prompt' | 'self'> = []

  const step = (signal: SelfTurnSignal): ReturnType<typeof selfTurnAction> => {
    const action = selfTurnAction({ claude, open, free: open === 'none' && !preparing, stopped, running }, signal)
    if (action === 'open') {
      open = 'self'
      opened.push('self')
      draft = ''
    }
    if (action === 'end') {
      if (draft.trim()) messages.push(draft.trim())
      open = 'none'
    }
    return action
  }

  return {
    messages,
    opened,
    isRunning: () => open !== 'none',
    /** A message of Claude Code's own, as `_claude/sdkMessage` brings it. */
    sdk(message: unknown): void {
      const signal = sdkSignal(message)
      if (!signal) return
      if (signal === 'running') running = true
      if (signal === 'idle') running = false
      step(signal)
    },
    text(chunk: string): void {
      const action = step('output')
      if (action === 'open' || action === 'keep') draft += chunk
    },
    toolCall(): void {
      step('output')
    },
    /** The user's message is being prepared: the chat has a turn, the session not yet. */
    prepare(): void {
      preparing = true
    },
    prompt(): void {
      preparing = false
      open = 'prompt'
      opened.push('prompt')
      stopped = false
      draft = ''
    },
    promptReturned(): void {
      messages.push(draft.trim())
      open = 'none'
    },
    stop(): void {
      stopped = true
      if (open === 'self' && draft.trim()) messages.push(draft.trim())
      if (open === 'self') open = 'none'
    }
  }
}

/** A prompted turn that leaves a background task behind, in the order Claude Code 2.1.322 sent it. */
function promptedTurn(chat: ReturnType<typeof session>, reply = 'WAITING'): void {
  chat.prompt()
  chat.sdk(state('running'))
  chat.toolCall()
  chat.text(reply)
  chat.sdk(result('human'))
  chat.promptReturned()
  chat.sdk(state('idle'))
}

describe('sdkSignal', () => {
  it('reads state changes and results', () => {
    expect(sdkSignal(state('running'))).toBe('running')
    expect(sdkSignal(state('idle'))).toBe('idle')
    expect(sdkSignal(state('requires_action'))).toBeNull()
    expect(sdkSignal(result('task-notification'))).toBe('result')
    expect(sdkSignal({ type: 'result', num_turns: 0, is_error: true })).toBe('result')
  })

  it('finds no signal in a placeholder result or any other message', () => {
    expect(sdkSignal(result('task-notification', 0))).toBeNull()
    expect(sdkSignal({ type: 'system', subtype: 'task_notification', status: 'completed' })).toBeNull()
    expect(sdkSignal(null)).toBeNull()
    expect(sdkSignal('idle')).toBeNull()
  })
})

describe('a turn the agent starts itself', () => {
  it('opens after a background task ends, keeps its text and saves one message at its result', () => {
    const chat = session()
    promptedTurn(chat)
    expect(chat.messages).toEqual(['WAITING'])
    expect(chat.isRunning()).toBe(false)

    chat.sdk({ type: 'system', subtype: 'task_notification', status: 'completed' })
    expect(chat.isRunning()).toBe(false)
    chat.sdk(state('running'))
    expect(chat.isRunning()).toBe(true)
    chat.toolCall()
    chat.text('The live site is ')
    chat.text('running the new build.')
    chat.sdk(result('task-notification'))
    expect(chat.isRunning()).toBe(false)
    chat.sdk(state('idle'))

    expect(chat.messages).toEqual(['WAITING', 'The live site is running the new build.'])
    expect(chat.opened).toEqual(['prompt', 'self'])
  })

  it('opens at its first output when the state stayed running', () => {
    const chat = session()
    chat.prompt()
    chat.sdk(state('running'))
    chat.text('Started two agents.')
    chat.sdk(result('human'))
    chat.promptReturned()
    // No idle: background agents still run. Their notification starts a turn without a state change.
    chat.text('Both agents are done.')
    expect(chat.isRunning()).toBe(true)
    chat.sdk(result('task-notification'))
    expect(chat.messages).toEqual(['Started two agents.', 'Both agents are done.'])
  })

  it('goes on past a placeholder result', () => {
    const chat = session()
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.sdk(result('task-notification', 0))
    expect(chat.isRunning()).toBe(true)
    chat.text('Done.')
    chat.sdk(result('task-notification'))
    expect(chat.messages).toEqual(['WAITING', 'Done.'])
  })

  it('ends at idle when no result came', () => {
    const chat = session()
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.text('Half a rep')
    chat.sdk(state('idle'))
    expect(chat.isRunning()).toBe(false)
    expect(chat.messages).toEqual(['WAITING', 'Half a rep'])
  })

  it('saves nothing and stops running when it wrote no text', () => {
    const chat = session()
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.toolCall()
    chat.sdk(result('task-notification'))
    chat.sdk(state('idle'))
    expect(chat.isRunning()).toBe(false)
    expect(chat.messages).toEqual(['WAITING'])

    chat.sdk(state('running'))
    chat.sdk(state('idle'))
    expect(chat.isRunning()).toBe(false)
    expect(chat.messages).toEqual(['WAITING'])
  })

  it('can be stopped, and what comes after the stop is dropped', () => {
    const chat = session()
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.text('Checking')
    chat.stop()
    expect(chat.isRunning()).toBe(false)
    chat.text(' the logs')
    chat.sdk(result('task-notification'))
    chat.sdk(state('idle'))
    expect(chat.isRunning()).toBe(false)
    expect(chat.messages).toEqual(['WAITING', 'Checking'])
  })
})

describe('output no turn is waiting for', () => {
  it('is dropped after Stop and opens nothing', () => {
    const chat = session()
    chat.prompt()
    chat.sdk(state('running'))
    chat.text('Working')
    chat.stop()
    chat.promptReturned()
    // The stopped turn's last words, and a task it left behind that ends later.
    chat.text(' on it')
    chat.toolCall()
    chat.sdk(state('idle'))
    chat.sdk(state('running'))
    chat.text('The task finished.')
    chat.sdk(result('task-notification'))
    chat.sdk(state('idle'))
    expect(chat.opened).toEqual(['prompt'])
    expect(chat.messages).toEqual(['Working'])

    // The next message of the user lifts the stop.
    promptedTurn(chat, 'Again')
    chat.sdk(state('running'))
    chat.text('Now it is done.')
    chat.sdk(result('task-notification'))
    expect(chat.messages).toEqual(['Working', 'Again', 'Now it is done.'])
  })

  it('is dropped while the session is not running, as when a session load replays the conversation', () => {
    const chat = session()
    chat.text('An earlier reply')
    chat.toolCall()
    expect(chat.isRunning()).toBe(false)
    expect(chat.opened).toEqual([])
  })

  it('is dropped while the chat prepares a turn of its own', () => {
    const chat = session()
    promptedTurn(chat)
    chat.prepare()
    chat.sdk(state('running'))
    chat.text('The task finished.')
    expect(chat.opened).toEqual(['prompt'])
  })
})

describe('next to a prompted turn', () => {
  it('leaves a prompt sent right after it ended alone', () => {
    const chat = session()
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.text('Background check passed.')
    chat.sdk(result('task-notification'))
    // The user's prompt goes out before the trailing idle of the turn that just ended.
    chat.prompt()
    chat.sdk(state('idle'))
    chat.sdk(state('running'))
    chat.text('Here is the answer.')
    expect(chat.isRunning()).toBe(true)
    chat.sdk(result('human'))
    expect(chat.isRunning()).toBe(true)
    chat.promptReturned()
    chat.sdk(state('idle'))
    expect(chat.messages).toEqual(['WAITING', 'Background check passed.', 'Here is the answer.'])
    expect(chat.opened).toEqual(['prompt', 'self', 'prompt'])
  })

  it('does not end a prompted turn at a result or an idle', () => {
    const context: SelfTurnContext = { claude: true, open: 'prompt', free: false, stopped: false, running: true }
    expect(selfTurnAction(context, 'result')).toBe('none')
    expect(selfTurnAction(context, 'idle')).toBe('none')
    expect(selfTurnAction(context, 'running')).toBe('none')
    expect(selfTurnAction(context, 'output')).toBe('keep')
  })
})

describe('a Grok session', () => {
  it('never opens a turn of its own', () => {
    const chat = session(false)
    promptedTurn(chat)
    chat.sdk(state('running'))
    chat.text('Late words')
    chat.toolCall()
    expect(chat.opened).toEqual(['prompt'])
    expect(chat.messages).toEqual(['WAITING'])
    for (const signal of ['running', 'idle', 'result', 'output'] as const) {
      const action = selfTurnAction({ claude: false, open: 'none', free: true, stopped: false, running: true }, signal)
      expect(action).toBe(signal === 'output' ? 'drop' : 'none')
    }
  })
})

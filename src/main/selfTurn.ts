/**
 * Claude Code runs a turn of its own when a background task or agent ends, with no prompt of ours
 * open. This decides what a session's output and state changes mean for such a turn.
 */

/** What Claude Code said, or sent, on a session. */
export type SelfTurnSignal =
  /** The session started working (`session_state_changed: running`). */
  | 'running'
  /** The session stopped working (`session_state_changed: idle`). */
  | 'idle'
  /** A turn's `result`. */
  | 'result'
  /** Reply text or a tool call of the main conversation. */
  | 'output'

export type SelfTurnContext = {
  /** The session runs Claude Code. Grok Build starts no turn of its own. */
  claude: boolean
  /** The turn the session has open: one we prompted, one the agent started itself, or none. */
  open: 'none' | 'prompt' | 'self'
  /** The session's chat can take a new turn: it has none, also not one still preparing, and is not rewinding. */
  free: boolean
  /** The user pressed Stop and has sent nothing since. What the session still says belongs to the stopped work. */
  stopped: boolean
  /** The session last said it was running. Messages replayed by a session load come while it does not. */
  running: boolean
}

export type SelfTurnAction =
  /** The agent started a turn itself: open one for it. Output that opened it is part of it. */
  | 'open'
  /** Output of the open turn. */
  | 'keep'
  /** Output no turn is waiting for: late words of a stopped or finished turn. */
  | 'drop'
  /** The turn the agent started itself is over. */
  | 'end'
  | 'none'

export function selfTurnAction(context: SelfTurnContext, signal: SelfTurnSignal): SelfTurnAction {
  if (context.open === 'self') {
    if (signal === 'output') return 'keep'
    return signal === 'running' ? 'none' : 'end'
  }
  // A turn we prompted ends when its prompt returns, not at these signals.
  if (context.open === 'prompt') return signal === 'output' ? 'keep' : 'none'
  if (signal === 'idle' || signal === 'result') return 'none'
  const starts = context.claude && context.free && !context.stopped && context.running
  if (starts) return 'open'
  return signal === 'output' ? 'drop' : 'none'
}

/** The signal in one of Claude Code's own messages (`_claude/sdkMessage`), or null when it carries none. */
export function sdkSignal(message: unknown): Exclude<SelfTurnSignal, 'output'> | null {
  if (!message || typeof message !== 'object') return null
  const record = message as {
    type?: unknown
    subtype?: unknown
    state?: unknown
    num_turns?: unknown
    is_error?: unknown
  }
  if (record.type === 'system' && record.subtype === 'session_state_changed') {
    return record.state === 'running' ? 'running' : record.state === 'idle' ? 'idle' : null
  }
  if (record.type !== 'result') return null
  // A result with no model turns is a placeholder that comes before the turn answering it.
  return (typeof record.num_turns === 'number' && record.num_turns > 0) || record.is_error === true ? 'result' : null
}

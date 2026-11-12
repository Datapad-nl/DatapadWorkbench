import type { ChatContext } from './types'

/**
 * Every model call sends the whole conversation again, so a long chat pays for its history on
 * each call. Past these marks a new chat that starts from a handoff file is the cheaper way on.
 */
export const HANDOFF_TOKENS = 120_000
export const HANDOFF_SHARE = 0.6

type ContextUpdate = {
  sessionUpdate?: string
  used?: number
  size?: number
  usage?: { inputTokens?: number; modelCalls?: number }
  tokens_used?: number
  context_window?: number
  tokens_after?: number
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** What a session update says about the context window, or null when it says nothing. */
export function contextFromUpdate(update: ContextUpdate, before?: ChatContext): ChatContext | null {
  const size = before?.size ?? null
  switch (update.sessionUpdate) {
    // Claude Code, after each turn and after a compaction.
    case 'usage_update': {
      const used = count(update.used)
      return used === null ? null : { used, size: count(update.size) || size }
    }
    // Grok Build gives the turn's input over all its model calls.
    case 'turn_completed': {
      const input = count(update.usage?.inputTokens)
      const calls = count(update.usage?.modelCalls)
      return input && calls ? { used: Math.round(input / calls), size, estimate: true } : null
    }
    case 'auto_compact_started': {
      const used = count(update.tokens_used)
      return used === null ? null : { used, size: count(update.context_window) || size }
    }
    case 'auto_compact_completed': {
      const used = count(update.tokens_after)
      return used === null ? null : { used, size }
    }
    default:
      return null
  }
}

export function handoffAdvised(context: ChatContext | null | undefined): boolean {
  if (!context) return false
  return context.used >= HANDOFF_TOKENS || (context.size ? context.used / context.size >= HANDOFF_SHARE : false)
}

/** "62%" of a known window, "140k" tokens of an unknown one; "~" marks an estimate. */
export function contextLabel(context: ChatContext): string {
  const amount = context.size
    ? `${Math.round((context.used / context.size) * 100)}%`
    : `${Math.max(1, Math.round(context.used / 1000))}k`
  return context.estimate ? `~${amount}` : amount
}

/** What /handoff sends: the agent writes the handoff and calls the `handoff` tool with it. */
export function handoffPrompt(note: string): string {
  const wish = note.trim()
  return [
    'Hand this conversation off to a new chat: call the `handoff` tool of the workbench MCP server, and do no other work in this turn.',
    'The new chat starts with only what you write in `summary`, so write it for an agent that has seen none of this conversation: the goal, where the work stands, the decisions made and why, the files that matter, what is verified and what is not, and what the user asked for along the way that still holds.',
    'Set `next` only to work the user has asked for that is not finished. Leave it out when that work is done, and the new chat waits for the user.',
    wish ? `The user adds, for the new chat: ${wish}` : '',
    'When the tool returns, reply with one line that says the work continues in the new chat.'
  ]
    .filter(Boolean)
    .join('\n')
}

/** The first message of the chat that continues `fromTitle`. */
export function handoffOpening(input: {
  fromTitle: string
  fromId: string
  file: string
  summary: string
  next: string
}): string {
  return [
    `This chat continues "${input.fromTitle}" with a fresh context. The handoff below is all that came along. It is saved at ${input.file}. For a detail it leaves out, read the earlier chat with read_chat (chat id ${input.fromId}) instead of guessing.`,
    input.summary.trim(),
    input.next.trim()
      ? `Start with this: ${input.next.trim()}`
      : 'Do not start work yet. Reply with one line that you are ready, and wait for the user.'
  ].join('\n\n')
}

import type { Message } from './types'

/** How much of the conversation a fresh session is handed. The newest part is kept. */
export const CARRY_OVER_CHARS = 60_000

/**
 * The conversation so far, for a chat that goes on in a new agent session: after it switched agent,
 * was rewound, or lost its session. Null when there is nothing before the message being sent.
 * Side answers (/btw) never reached the session, so they stay out.
 */
export function carryOverPrompt(earlier: Message[], chatId: string, limit = CARRY_OVER_CHARS): string | null {
  const turns = earlier
    .filter((message) => message.kind !== 'btw' && message.content.trim())
    .map((message) => {
      const who = message.role === 'user' ? 'User' : message.fromBot ? `Bot ${message.fromBot.name}` : 'Assistant'
      return `### ${who}\n${message.content.trim()}`
    })
  if (turns.length === 0) return null
  const kept: string[] = []
  let size = 0
  for (const turn of [...turns].reverse()) {
    if (size + turn.length > limit && kept.length > 0) break
    kept.unshift(turn.length > limit ? `…${turn.slice(-limit)}` : turn)
    size += turn.length
  }
  const cut = kept.length < turns.length
  return [
    'This chat continues in a new session, possibly on another model. Here is the conversation so far, so you can carry on from where it was. Tool calls and their output are not included: read files again where you need them.',
    cut
      ? `Only the most recent part is included. The whole chat can be read with \`read_chat\` of the \`workbench\` MCP server (chat id ${chatId}).`
      : null,
    '<conversation>',
    kept.join('\n\n'),
    '</conversation>',
    'The new message follows.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

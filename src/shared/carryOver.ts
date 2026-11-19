import type { Message } from './types'

/** How much of the conversation a fresh session is handed. The newest part is kept. */
export const CARRY_OVER_CHARS = 60_000

/**
 * The conversation so far, for a chat that goes on in a new agent session: after it switched agent,
 * was rewound, or lost its session. Null when there is nothing before the message being sent.
 * Side answers (/btw) never reached the session, so they stay out.
 */
export function carryOverPrompt(earlier: Message[], chatId: string, limit = CARRY_OVER_CHARS): string | null {
  const conversation = renderConversation(earlier, limit)
  if (!conversation) return null
  return [
    'This chat continues in a new session, possibly on another model. Here is the conversation so far, so you can carry on from where it was. Tool calls and their output are not included: read files again where you need them.',
    conversation.cut
      ? `Only the most recent part is included. The whole chat can be read with \`read_chat\` of the \`workbench\` MCP server (chat id ${chatId}).`
      : null,
    '<conversation>',
    conversation.text,
    '</conversation>',
    'The new message follows.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The conversation of the chat a bot was asked from, up to and with `lastId`, the chat's last
 * message when the bot was asked. When that is the user's message to the bots, it is the question
 * itself and stays out. Null when nothing precedes the question or the message is gone.
 */
export function askedFromPrompt(
  messages: Message[],
  lastId: string,
  title: string,
  limit = CARRY_OVER_CHARS
): string | null {
  const end = messages.findIndex((message) => message.id === lastId)
  if (end < 0) return null
  const earlier = messages.slice(0, messages[end].toBots ? end : end + 1)
  const conversation = renderConversation(earlier, limit)
  if (!conversation) return null
  return [
    `You were asked from the chat "${title}". Here is that chat's conversation up to the question, so you know what was being discussed. Tool calls and their output are not included: read files again where you need them.`,
    conversation.cut ? 'Only the most recent part is included.' : null,
    '<conversation>',
    conversation.text,
    '</conversation>',
    'The question follows.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The turns as Markdown, newest kept within `limit`. Side answers (/btw) and bots' acknowledgements stay out. */
function renderConversation(earlier: Message[], limit: number): { text: string; cut: boolean } | null {
  const turns = earlier
    .filter((message) => message.kind !== 'btw' && !message.fromBot?.pending && message.content.trim())
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
  return { text: kept.join('\n\n'), cut: kept.length < turns.length }
}

import type { BotMention, Message } from '../shared/types'

/** What the project's agent is told about the bots asked with @ and the answers they posted. */

/** Adds `block` to a prompt: after a slash command, which only runs when it starts the prompt, else before. */
function withBlock(text: string, block: string): string {
  if (/^\/\S/.test(text.trimStart())) return `${text}\n\n${block}`
  return text.trim() ? `${block}\n\n${text}` : block
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

export function promptForBotsAsked(text: string, bots?: BotMention[]): string {
  if (!bots || bots.length === 0) return text
  const names = bots.map((bot) => bot.name).join(', ')
  return withBlock(
    text,
    `The user also asked ${bots.length === 1 ? 'the bot' : 'the bots'} ${names} about this message. Each works on it by itself and posts its answer in this chat; you get it with your next prompt.`
  )
}

export function promptForBotAnswers(text: string, answers: Message[]): string {
  if (answers.length === 0) return text
  const body = answers
    .map((message) => `### ${message.fromBot?.name ?? 'Bot'}\n\n${clip(message.content, 8000)}`)
    .join('\n\n')
  return withBlock(text, `Bots answered in this chat since your last prompt:\n\n${body}`)
}

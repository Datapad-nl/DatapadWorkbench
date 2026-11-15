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

/** Bots named with @ inside the message: they are part of the request, and the agent works out what to do with them. */
export function promptForBotsMentioned(text: string, bots?: BotMention[]): string {
  if (!bots || bots.length === 0) return text
  const names = bots.map((bot) => `@${bot.name}`).join(', ')
  return withBlock(
    text,
    `The user names ${bots.length === 1 ? 'the bot' : 'the bots'} ${names} in this message. A bot is an agent of its own with its own skills; the name is part of the sentence. Work out from the request what the user wants with ${bots.length === 1 ? 'it' : 'them'}: when that is to give a bot something, ask it something or have it do something, call the workbench tool ask_bot with the bot's name and a message that stands on its own, with everything the bot needs. It returns the bot's answer, which the user also sees in this chat.`
  )
}

/** A bot's scheduled run or follow-up: nobody is watching, so it says something only with `notify`. */
export function promptForBotRun(text: string, run: { kind: 'schedule' | 'followUp' }): string {
  const what =
    run.kind === 'schedule'
      ? 'This is a scheduled run. It starts in a fresh session: your memory holds what earlier runs found and already reported.'
      : 'This is the follow-up you set earlier, in the session you set it from.'
  return withBlock(
    text,
    `${what} Nobody is watching: the user sees nothing of this run unless you call the workbench tool notify. Call it once, with a short message, only when there is something new the user needs to know or act on. When there is nothing new, finish without it. Before you finish, save in your own memory what a later run needs to know, such as what you reported. Leave the shared memory as it is in this run: writing there waits for the user.`
  )
}

export function promptForBotAnswers(text: string, answers: Message[]): string {
  if (answers.length === 0) return text
  const body = answers
    .map((message) => {
      const name = message.fromBot?.name ?? 'Bot'
      const question = message.fromBot?.question?.trim()
      const asked = question ? `The user asked it: ${clip(question, 2000)}\n\n` : ''
      return `### ${name}\n\n${asked}${clip(message.content, 8000)}`
    })
    .join('\n\n')
  return withBlock(text, `Bots answered in this chat since your last prompt:\n\n${body}`)
}

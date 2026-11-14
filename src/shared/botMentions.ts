import type { BotMention } from './types'

/**
 * Bots written as `@Name` in a message. A message that starts with them is addressed to those bots;
 * a bot named later is part of the sentence, for the project's agent to make sense of.
 */

/** The bot whose `@Name` starts at `index`, the longest name first so "Ads Checker" beats "Ads". */
function mentionAt(text: string, index: number, bots: BotMention[]): BotMention | null {
  if (text[index] !== '@') return null
  // A mention starts a word: not the middle of an email address.
  if (index > 0 && /[\p{L}\p{N}_]/u.test(text[index - 1])) return null
  const byLength = [...bots].sort((a, b) => b.name.length - a.name.length)
  for (const bot of byLength) {
    const name = bot.name.trim()
    if (!name || text.slice(index + 1, index + 1 + name.length).toLowerCase() !== name.toLowerCase()) continue
    const after = text[index + 1 + name.length]
    if (after === undefined || !/[\p{L}\p{N}_]/u.test(after)) return bot
  }
  return null
}

export type MessagePart = string | { bot: BotMention; text: string }

/** The text cut into plain runs and `@Name` mentions, for showing the names inline. */
export function botMentionParts(text: string, bots: BotMention[]): MessagePart[] {
  const parts: MessagePart[] = []
  let plain = ''
  let index = 0
  while (index < text.length) {
    const bot = mentionAt(text, index, bots)
    if (!bot) {
      plain += text[index]
      index += 1
      continue
    }
    if (plain) parts.push(plain)
    plain = ''
    const length = 1 + bot.name.trim().length
    parts.push({ bot, text: text.slice(index, index + length) })
    index += length
  }
  if (plain) parts.push(plain)
  return parts
}

/** The bots named with `@` anywhere in the text, each once, in the order they first appear. */
export function mentionedBots(text: string, bots: BotMention[]): BotMention[] {
  const found: BotMention[] = []
  for (const part of botMentionParts(text, bots)) {
    if (typeof part !== 'string' && !found.some((bot) => bot.id === part.bot.id)) found.push(part.bot)
  }
  return found
}

/**
 * `addressed`: the bots the message starts with, which it is sent to. `rest`: the message after them.
 * `referenced`: the other bots named in it, which are part of what the user asks.
 */
export function splitBotMentions(
  text: string,
  bots: BotMention[]
): { addressed: BotMention[]; referenced: BotMention[]; rest: string } {
  const addressed: BotMention[] = []
  let index = text.length - text.trimStart().length
  for (;;) {
    const bot = mentionAt(text, index, bots)
    if (!bot) break
    if (!addressed.some((item) => item.id === bot.id)) addressed.push(bot)
    index += 1 + bot.name.trim().length
    // "@Scout, @Lint check this" addresses both; a colon ends them: "@Scout: @Lint is flaky".
    while (index < text.length && /[\s,]/.test(text[index])) index += 1
    if (text[index] === ':') {
      index += 1
      break
    }
  }
  const rest = addressed.length > 0 ? text.slice(index).trim() : text
  const referenced = mentionedBots(rest, bots).filter((bot) => !addressed.some((item) => item.id === bot.id))
  return { addressed, referenced, rest }
}

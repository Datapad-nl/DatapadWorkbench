import type { Bot, ChatSummary } from '../shared/types'

/** What the menu bar menu says about each bot and each chat that waits for the user. */

export type TrayBot = { id: string; label: string }
export type TrayWaiting = { chatId: string; label: string }

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `today 09:00`, `tomorrow 09:00`, `Tue 09:00` within the week, else the date. */
export function whenLabel(at: Date, now: Date): string {
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000)
  if (days <= 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** Each bot with what it does: working now, else its next scheduled run. */
export function trayBots(
  bots: Array<Pick<Bot, 'id' | 'name'>>,
  chats: Array<Pick<ChatSummary, 'id' | 'botId' | 'schedule'>>,
  running: (chatId: string) => boolean,
  now: Date
): TrayBot[] {
  return bots.map((bot) => {
    const own = chats.filter((chat) => chat.botId === bot.id)
    const name = clip(bot.name, 40)
    if (own.some((chat) => running(chat.id))) return { id: bot.id, label: `${name} · working` }
    const next = own
      .map((chat) => Date.parse(chat.schedule?.nextRunAt ?? ''))
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b)[0]
    return { id: bot.id, label: next === undefined ? name : `${name} · next ${whenLabel(new Date(next), now)}` }
  })
}

/** One line per chat with a question or a permission waiting; a bot's chat is named after the bot. */
export function trayWaiting(
  requests: Array<{ chatId: string; kind: 'question' | 'permission' }>,
  chats: Array<Pick<ChatSummary, 'id' | 'title' | 'botId'>>,
  bots: Array<Pick<Bot, 'id' | 'name'>>
): TrayWaiting[] {
  const seen = new Set<string>()
  const lines: TrayWaiting[] = []
  for (const request of requests) {
    if (seen.has(request.chatId)) continue
    const chat = chats.find((item) => item.id === request.chatId)
    if (!chat) continue
    seen.add(request.chatId)
    const bot = chat.botId ? bots.find((item) => item.id === chat.botId) : undefined
    const title = clip(bot ? `${bot.name}: ${chat.title}` : chat.title || 'Chat', 50)
    lines.push({
      chatId: chat.id,
      label: `${title} · ${request.kind === 'question' ? 'answer a question' : 'allow a tool'}`
    })
  }
  return lines
}

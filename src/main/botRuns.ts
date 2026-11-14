/**
 * A bot's unattended runs: a scheduled run in one of its chats, or a follow-up it set. Nobody watches
 * them, so a finished one gets no notice of its own: the bot tells the user with `notify` when it has
 * something to say. Kept apart from chatTools.ts so grok.ts and ipc.ts can ask without an import cycle.
 */

export type BotRun = { botId: string; kind: 'schedule' | 'followUp'; note?: string }

const runs = new Map<string, BotRun>()

/** Gives the run back, so its own end cannot end a later run in the same chat. */
export function startBotRun(chatId: string, run: BotRun): BotRun {
  runs.set(chatId, run)
  return run
}

/** The unattended run in this chat, if one is running. */
export function botRun(chatId: string): BotRun | undefined {
  return runs.get(chatId)
}

/** Whether an unattended run of a bot is running in this chat. */
export function isBotRun(chatId: string): boolean {
  return runs.has(chatId)
}

/**
 * True when the run was still there: a deleted chat's run is ended early, and says nothing more. With
 * `run`, only that run ends, not one started in the chat since.
 */
export function endBotRun(chatId: string, run?: BotRun): boolean {
  if (run && runs.get(chatId) !== run) return false
  return runs.delete(chatId)
}

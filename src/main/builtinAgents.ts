import { BrowserWindow } from 'electron'
import {
  applyTaskNotification,
  applyToolUpdate,
  endForegroundAgents as endForeground,
  type BuiltinAgent,
  type BuiltinAgentsFeed
} from '../shared/builtinAgents'
import { onSessionUpdate, onTaskNotification } from './acp'
import { lookupSession } from './activity'

/** Claude Code's own agents per chat, since the app started. */
const byChat = new Map<string, BuiltinAgent[]>()
let started = false

function change(sessionId: string, apply: (agents: BuiltinAgent[]) => BuiltinAgent[]): void {
  const chatId = lookupSession(sessionId)?.id
  if (chatId) changeChat(chatId, apply)
}

function changeChat(chatId: string, apply: (agents: BuiltinAgent[]) => BuiltinAgent[]): void {
  const before = byChat.get(chatId) ?? []
  const agents = apply(before)
  if (agents === before) return
  byChat.set(chatId, agents)
  const feed: BuiltinAgentsFeed = { chatId, agents }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('builtinAgents:event', feed)
  }
}

/** A new turn of the chat starts, so the foreground agents of the turn before it are over. */
export function endForegroundAgents(chatId: string): void {
  changeChat(chatId, endForeground)
}

export function getBuiltinAgents(chatId: string): BuiltinAgent[] {
  return byChat.get(chatId) ?? []
}

export function startBuiltinAgentsBridge(): void {
  if (started) return
  started = true
  onSessionUpdate((event) => {
    change(event.sessionId, (agents) => applyToolUpdate(agents, event.update, new Date().toISOString()))
  })
  onTaskNotification((sessionId, message) => {
    change(sessionId, (agents) => applyTaskNotification(agents, message))
  })
}

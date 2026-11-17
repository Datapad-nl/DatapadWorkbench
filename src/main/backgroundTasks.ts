import { BrowserWindow } from 'electron'
import {
  applyTaskMessage,
  endBackgroundTasks,
  type BackgroundTask,
  type BackgroundTasksFeed
} from '../shared/backgroundTasks'
import { onSdkMessage, onSessionUpdate } from './acp'
import { lookupSession } from './activity'

/** Claude Code's background commands and monitors per chat, since the app started. */
const byChat = new Map<string, BackgroundTask[]>()
/** The session each chat's tasks belong to. */
const sessionOf = new Map<string, string>()
let started = false

function changeChat(chatId: string, apply: (tasks: BackgroundTask[]) => BackgroundTask[]): void {
  const before = byChat.get(chatId) ?? []
  const tasks = apply(before)
  if (tasks === before) return
  byChat.set(chatId, tasks)
  const feed: BackgroundTasksFeed = { chatId, tasks }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('backgroundTasks:event', feed)
  }
}

export function getBackgroundTasks(chatId: string): BackgroundTask[] {
  return byChat.get(chatId) ?? []
}

export function startBackgroundTasksBridge(): void {
  if (started) return
  started = true
  // The chat moved to another session: the tasks of the one before are over for it.
  onSessionUpdate((event) => {
    const chatId = lookupSession(event.sessionId)?.id
    if (!chatId || sessionOf.get(chatId) === event.sessionId) return
    sessionOf.set(chatId, event.sessionId)
    changeChat(chatId, endBackgroundTasks)
  })
  onSdkMessage((sessionId, message) => {
    const chatId = lookupSession(sessionId)?.id
    if (!chatId) return
    // A session the chat has left, such as one closed after it moved on, says nothing about its tasks.
    const current = sessionOf.get(chatId)
    if (current && current !== sessionId) return
    sessionOf.set(chatId, sessionId)
    changeChat(chatId, (tasks) => applyTaskMessage(tasks, message, new Date().toISOString()))
  })
}

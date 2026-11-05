import { app, BrowserWindow, Notification } from 'electron'

/** Chats that finished or asked for something while the app was in the background. */
const waiting = new Set<string>()
// A notification that is garbage collected loses its click handler, so hold on to it.
const shown = new Set<Notification>()

function setBadge(): void {
  app.setBadgeCount(waiting.size)
}

/** Clears the Dock badge once the user is back in the app. */
export function watchAttention(): void {
  app.on('browser-window-focus', () => {
    waiting.clear()
    setBadge()
  })
}

function oneLine(text: string): string {
  const line = text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * Tells the user about a chat when no Workbench window has focus.
 * `urgent` is for chats that are blocked until the user answers.
 */
export function notifyChat(
  chat: { id: string; title: string },
  body: string,
  open: (chatId: string) => void,
  urgent = false
): void {
  if (BrowserWindow.getFocusedWindow()) return
  waiting.add(chat.id)
  setBadge()
  if (urgent) app.dock?.bounce('informational')
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: chat.title || 'Datapad Workbench', body: oneLine(body) })
  shown.add(notification)
  const forget = (): void => {
    shown.delete(notification)
  }
  notification.on('click', () => {
    forget()
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    open(chat.id)
  })
  notification.on('close', forget)
  notification.show()
}

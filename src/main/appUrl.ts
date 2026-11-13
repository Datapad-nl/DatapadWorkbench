import { is } from '@electron-toolkit/utils'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { BrowserWindow } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/** The page the window shows: the dev server in development, else the bundled index.html. */
export function devServerUrl(): string | null {
  return is.dev && process.env['ELECTRON_RENDERER_URL'] ? process.env['ELECTRON_RENDERER_URL'] : null
}

export function appIndexPath(): string {
  return join(__dirname, '../renderer/index.html')
}

function samePath(a: string, b: string): boolean {
  // Windows paths may differ only in the case of the drive letter.
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** True only for the app's own page, so a dropped file or another file: URL never counts. */
export function isAppUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const dev = devServerUrl()
  if (dev) return parsed.origin === new URL(dev).origin
  if (parsed.protocol !== 'file:') return false
  try {
    return samePath(resolve(fileURLToPath(parsed)), resolve(appIndexPath()))
  } catch {
    return false
  }
}

/** IPC is for the app's own page in its top frame, not frames or pages loaded inside it. */
export function isAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent) return false
  // The BrowserPane is a view inside the window, not the window's own page.
  if (BrowserWindow.fromWebContents(event.sender)?.webContents !== event.sender) return false
  return isAppUrl(frame.url)
}

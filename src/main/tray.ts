import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import icon from '../../resources/icon.png?asset'
import trayTemplate from '../../resources/trayTemplate.png?asset'
import { listBots } from './bots'
import { isStreaming } from './grok'
import { pendingPermissionRequests } from './permissions'
import { pendingQuestionRequests } from './questions'
import { listChats } from './store'
import { trayBots, trayWaiting } from './trayMenu'

/** The menu bar icon, so the app is at hand while it runs bots with no window open. */

type TrayActions = {
  show: () => void
  openChat: (chatId: string) => void
  openBot: (botId: string) => void
}

/** Windows passes this at login; macOS says so itself. */
const HIDDEN_ARG = '--hidden'
const loginArgs = process.platform === 'win32' ? { args: [HIDDEN_ARG] } : {}

let tray: Tray | null = null

/** A dev build would register the Electron binary, and Linux has no login items. */
function loginItemSupported(): boolean {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')
}

/** Started by the login item: open without a window. */
export function openedAtLogin(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

async function buildMenu(actions: TrayActions): Promise<Menu> {
  const [bots, chats] = await Promise.all([listBots().catch(() => []), listChats().catch(() => [])])
  const requests = [
    ...pendingQuestionRequests().map((request) => ({ chatId: request.chatId, kind: 'question' as const })),
    ...pendingPermissionRequests().map((request) => ({ chatId: request.chatId, kind: 'permission' as const }))
  ]
  const waiting = trayWaiting(requests, chats, bots)
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Datapad Workbench', click: actions.show }
  ]
  if (bots.length > 0) {
    items.push({ type: 'separator' }, { label: 'Bots', enabled: false })
    for (const bot of trayBots(bots, chats, isStreaming, new Date())) {
      items.push({ label: bot.label, click: () => actions.openBot(bot.id) })
    }
  }
  if (waiting.length > 0) {
    items.push({ type: 'separator' }, { label: 'Waiting for you', enabled: false })
    for (const line of waiting) items.push({ label: line.label, click: () => actions.openChat(line.chatId) })
  }
  items.push({ type: 'separator' })
  if (loginItemSupported()) {
    items.push({
      label: 'Open at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginArgs).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginArgs })
    })
  }
  items.push({ label: 'Quit Datapad Workbench', click: () => app.quit() })
  return Menu.buildFromTemplate(items)
}

export function startTray(actions: TrayActions): void {
  if (tray) return
  const image =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(trayTemplate)
      : nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('Datapad Workbench')
  // Built on each click, so bots, next runs and waiting chats are current.
  const popUp = (): void => {
    void buildMenu(actions).then((menu) => tray?.popUpContextMenu(menu))
  }
  if (process.platform === 'linux') {
    // Linux trays only show a menu that was set ahead of the click.
    const refresh = (): void => {
      void buildMenu(actions).then((menu) => tray?.setContextMenu(menu))
    }
    refresh()
    setInterval(refresh, 30_000)
    return
  }
  // A left click on Windows opens the app, as other tray apps do.
  tray.on('click', process.platform === 'win32' ? actions.show : popUp)
  tray.on('right-click', popUp)
}

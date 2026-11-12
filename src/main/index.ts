import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startUpdater, stopUpdater } from './updater'
import { stopAgents } from './acp'
import icon from '../../resources/icon.png?asset'
import { startBrowserAgentServer } from './browserAgent'
import { attachBrowser, navigateBrowser, prepareBrowser, sanitizeUrl } from './browser'
import { augmentPath, killOrphanCodegraphInits, stopCodegraphJobs } from './codegraph'
import { attachContextMenu } from './contextMenu'
import { loadDotEnv } from './env'
import { stopGitWatchers } from './git'
import { stopKnowledgeJobs, stopKnowledgeWatchers } from './knowledge'
import {
  startWorktreeReaper,
  stopWorktreeReaper,
  sweepWorktreeProcesses,
  sweepWorktreeProcessesSync
} from './worktreeProcs'
import { openBotFromTray, openFromNotice, registerIpc } from './ipc'
import { hasRunningTurns, stopAllTurnsAndWait } from './grok'
import { startScheduler } from './chatTools'
import { openedAtLogin, startTray } from './tray'
import { startPrWatcher } from './pullRequests'
import {
  ensureStore,
  onUnreadableProjects,
  purgeUnsafeProjects,
  syncClaudeSessions,
  syncGrokSessions,
  unreadableProjectsMovedTo
} from './store'
import { applyWindowChrome, getThemeState } from './themes'
import { attachMediaProtocol } from './media'
import { attachVisualProtocol } from './visuals'
import { attachVoiceProtocol, ensureMicAccess, getMicAccess, registerVoiceScheme } from './voice'
import { loadWindowState, trackWindowState } from './windowState'

// Installed builds would name this folder after the product. Keep the one `npm run dev` uses
// so chats, projects and downloaded voice models carry over.
app.setPath('userData', join(app.getPath('appData'), 'datapad-workbench'))

registerVoiceScheme()

if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9333')
}

// Closing the window keeps the app in the tray, so opening it again on Windows or Linux shows that
// window instead of starting a second app. macOS does this itself, and a dev build may run next to
// the installed app.
const secondInstance = app.isPackaged && process.platform !== 'darwin' && !app.requestSingleInstanceLock()
if (secondInstance) app.quit()

/** Set once the app quits for real; until then closing the window only hides it. */
let quitting = false
let appWindow: BrowserWindow | null = null

/** Brings the window back, or makes a new one if it is gone. */
function showWindow(): void {
  if (!appWindow) {
    createWindow()
    return
  }
  if (appWindow.isMinimized()) appWindow.restore()
  appWindow.show()
  appWindow.focus()
}

/** Bots keep running with the window closed: hide it, and on macOS leave the Dock for the menu bar. */
function hideWindow(window: BrowserWindow): void {
  if (window.isFullScreen()) {
    window.once('leave-full-screen', () => hideWindow(window))
    window.setFullScreen(false)
    return
  }
  window.hide()
  app.dock?.hide()
}

function createWindow(hidden = false): void {
  const state = loadWindowState()
  const mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x != null && state.y != null ? { x: state.x, y: state.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#141414',
    title: 'Datapad Workbench',
    icon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  function isMicPermission(permission: string): boolean {
    return permission === 'media' || permission === 'audioCapture' || permission === 'microphone'
  }

  /** The copy buttons write with `navigator.clipboard.writeText`, which asks for this. */
  function isClipboardWrite(permission: string): boolean {
    return permission === 'clipboard-sanitized-write'
  }

  mainWindow.webContents.session.setPermissionCheckHandler((_contents, permission) => {
    return isMicPermission(permission) || isClipboardWrite(permission)
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    const mic = isMicPermission(permission)
    callback(mic || isClipboardWrite(permission))
    if (mic && getMicAccess() !== 'granted') void ensureMicAccess()
  })

  trackWindowState(mainWindow)
  attachContextMenu(mainWindow)

  appWindow = mainWindow
  mainWindow.on('closed', () => {
    if (appWindow === mainWindow) appWindow = null
  })
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    hideWindow(mainWindow)
  })
  mainWindow.on('show', () => void app.dock?.show())

  mainWindow.on('ready-to-show', () => {
    if (hidden) {
      if (state.isMaximized) mainWindow.once('show', () => mainWindow.maximize())
      return
    }
    if (state.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  function isAppUrl(url: string): boolean {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      return url.startsWith(process.env['ELECTRON_RENDERER_URL'])
    }
    try {
      return new URL(url).protocol === 'file:'
    } catch {
      return false
    }
  }

  function openInAppBrowser(url: string): void {
    const clean = sanitizeUrl(url)
    if (clean) {
      void navigateBrowser(clean)
      return
    }
    void shell.openExternal(url)
  }

  // Same-window <a> clicks replace the renderer unless we cancel them.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openInAppBrowser(url)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    openInAppBrowser(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  attachBrowser(mainWindow)
}

app.whenReady().then(async () => {
  if (secondInstance) return
  loadDotEnv()
  augmentPath()
  app.setName('Datapad Workbench')
  electronApp.setAppUserModelId('com.datapad.workbench')
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  await ensureStore()
  await purgeUnsafeProjects()
  await syncGrokSessions()
  await syncClaudeSessions()
  attachVoiceProtocol()
  attachMediaProtocol()
  attachVisualProtocol()
  void ensureMicAccess()
  await prepareBrowser()
  // The app still opens if the browser tools' server can't start. The next chat to start tries again.
  await startBrowserAgentServer().catch((error) => console.error('Browser agent server did not start', error))
  registerIpc()
  startScheduler()
  startPrWatcher()
  killOrphanCodegraphInits()
  void sweepWorktreeProcesses()
  startWorktreeReaper()
  const hidden = openedAtLogin()
  if (hidden) app.dock?.hide()
  createWindow(hidden)
  startTray({
    show: showWindow,
    openChat: (chatId) => {
      showWindow()
      openFromNotice(chatId)
    },
    openBot: (botId) => {
      showWindow()
      openBotFromTray(botId)
    }
  })
  const movedTo = unreadableProjectsMovedTo()
  if (movedTo) void warnUnreadableProjects(movedTo)
  // It can also break while the app runs; the sidebar would empty with no word why.
  onUnreadableProjects((aside) => void warnUnreadableProjects(aside))
  startUpdater()
  const { active } = await getThemeState()
  applyWindowChrome(active)

  app.on('activate', showWindow)
  app.on('second-instance', showWindow)
})

/** The project list starts empty after projects.json failed to parse. Say so, and where the old file went. */
async function warnUnreadableProjects(movedTo: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Your project list could not be read',
    detail:
      `projects.json did not parse, so it was moved to ${movedTo} and the list starts empty. ` +
      'To get your projects back, quit, rename that file to projects.json, and open the app again. ' +
      'Until the list has a project again, Grok sessions are not turned into new projects.',
    buttons: ['Show the file', 'OK'],
    defaultId: 1,
    cancelId: 1
  })
  if (response === 0) shell.showItemInFolder(movedTo)
}

let turnsSaved = false

// The update closes the windows before it quits the app.
autoUpdater.on('before-quit-for-update', () => {
  quitting = true
})

app.on('before-quit', (event) => {
  quitting = true
  // Running turns save what they streamed before the agents go. A stuck turn holds the quit 3s at most.
  if (!turnsSaved && hasRunningTurns()) {
    event.preventDefault()
    turnsSaved = true
    void stopAllTurnsAndWait(3_000).finally(() => app.quit())
    return
  }
  turnsSaved = true
  // Agent processes would otherwise outlive the app and keep running their turns.
  stopAgents()
  stopWorktreeReaper()
  stopCodegraphJobs()
  killOrphanCodegraphInits()
  stopGitWatchers()
  stopKnowledgeJobs()
  stopKnowledgeWatchers()
  stopUpdater()
  sweepWorktreeProcessesSync()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

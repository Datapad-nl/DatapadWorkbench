import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startUpdater, stopUpdater } from './updater'
import { stopAgents } from './acp'
import icon from '../../resources/icon.png?asset'
import { startBrowserAgentServer } from './browserAgent'
import { activeBrowserScope, attachBrowser, navigateBrowser, prepareBrowser, sanitizeUrl } from './browser'
import { augmentPath, killOrphanCodegraphInits, stopCodegraphJobs } from './codegraph'
import { appIndexPath, devServerUrl, isAppUrl } from './appUrl'
import { attachContextMenu } from './contextMenu'
import { loadDotEnv } from './env'
import { setGitActiveProject, stopGitWatchers } from './git'
import { setKnowledgeActiveProject, stopKnowledgeJobs, stopKnowledgeWatchers } from './knowledge'
import {
  startWorktreeReaper,
  stopWorktreeReaper,
  sweepWorktreeProcesses,
  sweepWorktreeProcessesSync
} from './worktreeProcs'
import { openBotFromTray, openFromNotice, registerIpc } from './ipc'
import { hasRunningTurns, onChatLive, stopAllTurnsAndWait, stopIdleAgents } from './grok'
import { ensureChief, startScheduler } from './chatTools'
import { openedAtLogin, startTray } from './tray'
import { startPrWatcher } from './pullRequests'
import { startChannels, stopChannels } from './channels'
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
// A test version next to the open app must not write the real data, so dev can point userData elsewhere.
app.setPath(
  'userData',
  (is.dev && process.env['WORKBENCH_USER_DATA']) || join(app.getPath('appData'), 'datapad-workbench')
)
// Named before ready: the keychain key that encrypts secrets, the API key and cookies is named after
// the app, so dev and installed builds must share the name to read each other's data.
app.setName('Datapad Workbench')

registerVoiceScheme()

// Remote debugging lets any local process drive the app, so it is only on when asked for.
if (is.dev && process.env['WORKBENCH_REMOTE_DEBUGGING_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['WORKBENCH_REMOTE_DEBUGGING_PORT'])
}

// Closing the window keeps the app in the tray, so opening it again on Windows or Linux shows that
// window instead of starting a second app. macOS does this itself, and a dev build may run next to
// the installed app.
const secondInstance = app.isPackaged && process.platform !== 'darwin' && !app.requestSingleInstanceLock()
if (secondInstance) app.quit()

/** Set once the app quits for real; until then closing the window leaves the app in the menu bar. */
let quitting = false
let appWindow: BrowserWindow | null = null

/** Brings the window back, or makes a new one if it is gone. True when it is new and still loading. */
function showWindow(): boolean {
  if (!appWindow) {
    createWindow()
    return true
  }
  if (appWindow.isMinimized()) appWindow.restore()
  appWindow.show()
  appWindow.focus()
  return false
}

function createWindow(): void {
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
  // A window made again after a close takes the theme's background too.
  void getThemeState().then(({ active }) => applyWindowChrome(active))

  appWindow = mainWindow
  mainWindow.on('closed', () => {
    if (appWindow !== mainWindow) return
    appWindow = null
    if (quitting) return
    // Only what bots need runs on: idle agents and the watchers of the open panes stop, and start again when used.
    stopIdleAgents()
    void setGitActiveProject(null)
    void setKnowledgeActiveProject(null)
  })
  // Bots keep running with the window closed, from the menu bar. The window and its pages go, which frees
  // their memory, and on macOS the Dock icon goes too.
  mainWindow.on('close', (event) => {
    if (quitting) return
    // A full-screen window closed as it is leaves a black space behind.
    if (mainWindow.isFullScreen()) {
      event.preventDefault()
      mainWindow.once('leave-full-screen', () => mainWindow.close())
      mainWindow.setFullScreen(false)
      return
    }
    app.dock?.hide()
  })
  mainWindow.on('show', () => void app.dock?.show())

  mainWindow.on('ready-to-show', () => {
    if (state.isMaximized) mainWindow.maximize()
    mainWindow.show()
  })

  function openInAppBrowser(url: string): void {
    const clean = sanitizeUrl(url)
    if (clean) {
      void navigateBrowser(activeBrowserScope(), clean)
      return
    }
    // Other schemes (file:, smb: and the like) could open or run something local, so only mail goes out.
    try {
      if (new URL(url).protocol === 'mailto:') void shell.openExternal(url)
    } catch {
      // Not a URL: nothing to open.
    }
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

  const devUrl = devServerUrl()
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(appIndexPath())
  }

  attachBrowser(mainWindow)
}

app.whenReady().then(async () => {
  if (secondInstance) return
  loadDotEnv()
  augmentPath()
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
  registerIpc(showWindow)
  // The app still opens if the chief of staff cannot be made. The next start tries again.
  await ensureChief().catch((error) => console.error('Chief of staff not ready', error))
  startScheduler()
  void startChannels().catch(() => {})
  startPrWatcher()
  killOrphanCodegraphInits()
  void sweepWorktreeProcesses()
  startWorktreeReaper()
  // Opened at login, the app makes no window until the user asks for one.
  if (openedAtLogin()) app.dock?.hide()
  else createWindow()
  startTray({ show: showWindow, openChat: openFromNotice, openBot: openBotFromTray })
  // A turn that ends with no window open, such as a bot's scheduled run, leaves no agent idling.
  // After a tick, so a turn that follows at once, such as a queued steer, has claimed its agent.
  onChatLive((event) => {
    if (!appWindow && (event.type === 'done' || event.type === 'error')) setImmediate(stopIdleAgents)
  })
  const movedTo = unreadableProjectsMovedTo()
  if (movedTo) void warnUnreadableProjects(movedTo)
  // It can also break while the app runs; the sidebar would empty with no word why.
  onUnreadableProjects((aside) => void warnUnreadableProjects(aside))
  startUpdater()

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
  stopChannels()
  stopWorktreeReaper()
  stopCodegraphJobs()
  killOrphanCodegraphInits()
  stopGitWatchers()
  stopKnowledgeJobs()
  stopKnowledgeWatchers()
  stopUpdater()
  sweepWorktreeProcessesSync()
})

// Closing the window leaves the app in the tray, so it does not quit with the last window, here or on macOS.
app.on('window-all-closed', () => {})

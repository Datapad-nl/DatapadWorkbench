import { app, BaseWindow, BrowserWindow, WebContentsView, session } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { BrowserAnnotationHit, BrowserBounds, BrowserState, BrowserTab } from '../shared/types'
import { ANNOTATE_CANCEL, ANNOTATE_CLEANUP, ANNOTATE_PICKER } from './annotatePicker'
import { addTab, closeTab, emptyTabList, parseSavedTabs, selectTab, type SavedTab, type TabList } from './browserTabs'
import { id as newId } from './ids'

const PARTITION = 'persist:workbench-browser'

export type ConsoleEntry = { level: string; message: string; source: string; at: string }
const CONSOLE_LIMIT = 200

/**
 * Tabs per scope: a project id, or `bot:<botId>` for a bot's own chats. The window shows the active tab of
 * the active scope; agents drive the active tab of their chat's scope, on screen or not. A tab gets its
 * page only once it is the active one, so a restored tab costs nothing until it is opened.
 */
type Page = { view: WebContentsView; error: string | null; console: ConsoleEntry[]; loadedPersisted: boolean }
// Keyed by tab id.
const pages = new Map<string, Page>()
let savedTabs: Record<string, TabList> = {}

let host: BrowserWindow | null = null
let park: BaseWindow | null = null
let activeScope: string | null = null
let visible = false
let lastBounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
// The pane's last real size, so a page off screen lays out as it would in the pane.
let paneSize = { width: 1280, height: 800 }
let persistReady: Promise<void> | null = null
let lastEmitted = ''
let emitTimer: ReturnType<typeof setTimeout> | null = null
let persistWrite: Promise<void> = Promise.resolve()
let picking = false
let pickTab: string | null = null
let pickSession = 0
let endPick: (() => void) | null = null

function persistPath(): string {
  return join(app.getPath('userData'), 'workbench', 'browser.json')
}

export function sanitizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const raw = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

let permissionsLocked = false

function guestSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  // Pages in the pane are untrusted, so they get no camera, microphone, location, clipboard or the like.
  if (!permissionsLocked) {
    permissionsLocked = true
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  }
  const current = ses.getUserAgent()
  const stripped = current.replace(/\sElectron\/\S+/, '')
  if (stripped !== current) ses.setUserAgent(stripped)
  return ses
}

/** The scope's tabs, starting with one empty tab the first time the scope is used. */
function tabList(scope: string): TabList {
  savedTabs[scope] ??= emptyTabList(newId)
  return savedTabs[scope]
}

function activeTab(scope: string): SavedTab {
  const list = tabList(scope)
  return list.tabs.find((tab) => tab.id === list.active) ?? list.tabs[0]
}

/** The scope's active tab id, without starting a tab list for it. */
function activeTabId(scope: string | null): string | null {
  return (scope ? savedTabs[scope]?.active : null) ?? null
}

function liveContents(tabId: string | null): Electron.WebContents | null {
  const page = tabId ? pages.get(tabId) : undefined
  if (!page || page.view.webContents.isDestroyed()) return null
  return page.view.webContents
}

function contents(scope: string | null): Electron.WebContents | null {
  return liveContents(activeTabId(scope))
}

/** The scope the window shows: the project or bot the user is in. */
export function activeBrowserScope(): string | null {
  return activeScope
}

/** The page of `scope`, created on demand, for tools that read or drive it. */
export function browserContents(scope: string): Electron.WebContents {
  const wc = ensurePage(scope).view.webContents
  loadPersistedIfNeeded(scope)
  return wc
}

/** Whether the page of `scope` is painted (on screen or parked), so real input events reach it. */
export function browserPainted(scope: string): boolean {
  return Boolean(host && !host.isDestroyed() && contents(scope))
}

/** The page's console since the last navigation, oldest first. */
export function browserConsole(scope: string): ConsoleEntry[] {
  const tabId = activeTabId(scope)
  return [...((tabId ? pages.get(tabId)?.console : undefined) ?? [])]
}

function stateKey(state: BrowserState): string {
  return `${state.url}\0${state.title}\0${state.canGoBack}\0${state.canGoForward}\0${state.loading}\0${state.visible}\0${state.error ?? ''}\0${state.activeTabId ?? ''}\0${JSON.stringify(state.tabs)}`
}

/** Pushes the active scope's state; other scopes changing are nothing the window shows. */
function emit(immediate = false): void {
  const send = (): void => {
    emitTimer = null
    const state = getBrowserState(activeScope)
    const key = stateKey(state)
    if (key === lastEmitted) return
    lastEmitted = key
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('browser:state', state)
    }
  }
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer)
    send()
    return
  }
  if (emitTimer) return
  emitTimer = setTimeout(send, 80)
}

/** Opens the pane, only for the scope on screen: work in another project does not change what the user sees. */
export function requestShowBrowser(scope: string): void {
  if (scope !== activeScope) return
  setBrowserVisible(true)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('browser:requestShow')
  }
}

async function loadPersisted(): Promise<void> {
  try {
    savedTabs = parseSavedTabs(JSON.parse(await readFile(persistPath(), 'utf8')), sanitizeUrl, newId)
  } catch {
    savedTabs = {}
  }
}

function writePersisted(): Promise<void> {
  const body = JSON.stringify({ tabs: savedTabs })
  // One write at a time, so an older list never lands after a newer one.
  const write = async (): Promise<void> => {
    await mkdir(join(app.getPath('userData'), 'workbench'), { recursive: true })
    await writeFile(persistPath(), body, 'utf8')
  }
  const next = persistWrite.then(write)
  persistWrite = next.catch(() => undefined)
  return next
}

function findTab(scope: string, tabId: string): SavedTab | undefined {
  return savedTabs[scope]?.tabs.find((tab) => tab.id === tabId)
}

async function savePersisted(scope: string, tabId: string, url: string): Promise<void> {
  const tab = findTab(scope, tabId)
  const clean = sanitizeUrl(url)
  if (!tab || !clean) return
  tab.url = clean
  const wc = liveContents(tabId)
  if (wc) tab.title = wc.getTitle()
  await writePersisted()
}

/** Whether the active page is actually on screen: wanted, laid out at a usable size, in a window the user sees. */
function onScreen(): boolean {
  return (
    visible &&
    lastBounds.width >= 2 &&
    lastBounds.height >= 2 &&
    Boolean(host && !host.isDestroyed() && host.isVisible() && !host.isMinimized())
  )
}

/**
 * Pages off screen wait in an invisible window that is still on screen: Chromium paints only views it
 * shows, and a hidden view, or one outside or under the app's own, either cannot be captured or shows.
 */
function parkWindow(): BaseWindow {
  if (!park || park.isDestroyed()) {
    park = new BaseWindow({
      ...paneSize,
      useContentSize: true,
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      opacity: 0
    })
    park.setIgnoreMouseEvents(true)
    if (process.platform === 'darwin') {
      park.setHiddenInMissionControl(true)
      park.excludedFromShownWindowsMenu = true
    }
    park.showInactive()
  }
  // The window follows the pane size, so a parked page is never larger than its window.
  const [width, height] = park.getContentSize()
  if (width !== paneSize.width || height !== paneSize.height) park.setContentSize(paneSize.width, paneSize.height)
  return park
}

function place(view: WebContentsView, window: BaseWindow, bounds: BrowserBounds): void {
  for (const other of [host, park]) {
    if (other && other !== window && !other.isDestroyed() && other.contentView.children.includes(view)) {
      other.contentView.removeChildView(view)
    }
  }
  if (!window.contentView.children.includes(view)) window.contentView.addChildView(view)
  view.setBounds(bounds)
}

function applyBounds(): void {
  if (!host || host.isDestroyed()) return
  const show = onScreen()
  const shown = activeTabId(activeScope)
  for (const [tabId, page] of pages) {
    if (page.view.webContents.isDestroyed()) continue
    if (show && tabId === shown) place(page.view, host, lastBounds)
    else place(page.view, parkWindow(), { x: 0, y: 0, ...paneSize })
  }
}

/** Takes a closed tab's page out of the windows and ends it. */
function closePage(page: Page): void {
  for (const window of [host, park]) {
    if (window && !window.isDestroyed() && window.contentView.children.includes(page.view)) {
      window.contentView.removeChildView(page.view)
    }
  }
  if (!page.view.webContents.isDestroyed()) page.view.webContents.close()
}

function loadPersistedIfNeeded(scope: string): void {
  const tab = activeTab(scope)
  const page = pages.get(tab.id)
  const url = tab.url
  if (!page || page.loadedPersisted || !url) return
  page.loadedPersisted = true
  const wc = page.view.webContents
  if (wc.isDestroyed() || sanitizeUrl(wc.getURL())) return
  void wc.loadURL(url)
}

function wireContents(scope: string, tabId: string, page: Page): void {
  const wc = page.view.webContents
  // Any tab of the scope on screen changing shows in its tab strip.
  const changed = (): void => {
    if (scope === activeScope) emit()
  }

  wc.setWindowOpenHandler((details) => {
    const url = sanitizeUrl(details.url)
    if (url) void navigateBrowser(scope, url)
    return { action: 'deny' }
  })

  wc.on('will-navigate', (event, url) => {
    if (!sanitizeUrl(url)) event.preventDefault()
  })

  wc.on('will-redirect', (event, url) => {
    if (!sanitizeUrl(url)) event.preventDefault()
  })

  const onChange = (): void => {
    const url = wc.getURL()
    if (sanitizeUrl(url)) void savePersisted(scope, tabId, url)
    changed()
  }

  wc.on('console-message', (details) => {
    const where = details.sourceId ? `${details.sourceId}:${details.lineNumber}` : ''
    page.console.push({
      level: details.level,
      message: details.message,
      source: where,
      at: new Date().toISOString()
    })
    if (page.console.length > CONSOLE_LIMIT) page.console.splice(0, page.console.length - CONSOLE_LIMIT)
  })
  wc.on('did-navigate', () => {
    page.console.length = 0
  })
  wc.on('did-navigate', onChange)
  wc.on('did-navigate-in-page', onChange)
  wc.on('page-title-updated', () => {
    const tab = findTab(scope, tabId)
    if (tab) tab.title = wc.getTitle()
    changed()
  })
  wc.on('did-start-loading', () => {
    page.error = null
    changed()
  })
  // Only a new main document ends a pick; subframe loads and in-page navigations do not.
  wc.on('did-start-navigation', (details) => {
    if (picking && pickTab === tabId && details.isMainFrame && !details.isSameDocument) void cancelBrowserAnnotate()
  })
  wc.on('render-process-gone', () => {
    if (picking && pickTab === tabId) void cancelBrowserAnnotate()
  })
  wc.on('did-stop-loading', onChange)
  wc.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    page.error = errorDescription || 'Failed to load'
    changed()
  })
}

function ensurePage(scope: string): Page {
  const tabId = activeTab(scope).id
  const existing = pages.get(tabId)
  if (existing && !existing.view.webContents.isDestroyed()) return existing

  const view = new WebContentsView({
    webPreferences: {
      session: guestSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // A parked page is painted for captures even when the user's windows cover it.
      backgroundThrottling: false,
      // A new document would take keyboard focus from the chat the user is typing in. The user's own clicks still focus the page.
      focusOnNavigation: false
    }
  })
  view.setBackgroundColor('#141414')
  const page: Page = { view, error: null, console: [], loadedPersisted: false }
  pages.set(tabId, page)
  wireContents(scope, tabId, page)
  applyBounds()
  return page
}

export async function prepareBrowser(): Promise<void> {
  persistReady ??= loadPersisted()
  await persistReady
}

function layoutHost(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const [width, height] = window.getContentSize()
  const views = new Set([...pages.values()].map((page) => page.view))
  for (const child of window.contentView.children) {
    if (views.has(child as WebContentsView)) continue
    child.setBounds({ x: 0, y: 0, width, height })
  }
  applyBounds()
}

export function attachBrowser(window: BrowserWindow): void {
  host = window
  // The new window has not had a state push yet.
  lastEmitted = ''
  if (visible && activeScope) {
    ensurePage(activeScope)
    loadPersistedIfNeeded(activeScope)
  }
  // Pages the agents created while no window was open are placed here too.
  layoutHost(window)

  const relayout = (): void => layoutHost(window)
  window.on('resize', relayout)
  window.on('show', relayout)
  window.on('ready-to-show', relayout)
  window.on('enter-full-screen', relayout)
  window.on('leave-full-screen', relayout)
  // A hidden or minimized window cannot be captured, so its page moves to the parking window.
  window.on('hide', relayout)
  window.on('minimize', relayout)
  window.on('restore', relayout)

  window.on('closed', () => {
    if (host !== window) return
    if (picking) void cancelBrowserAnnotate()
    for (const page of pages.values()) {
      if (page.view.webContents.isDestroyed()) continue
      try {
        window.contentView.removeChildView(page.view)
      } catch {
        // window already tearing down
      }
      page.view.webContents.close()
    }
    // The next window gets fresh pages, which load their saved page again.
    pages.clear()
    if (park && !park.isDestroyed()) park.destroy()
    park = null
    host = null
    visible = false
    lastBounds = { x: 0, y: 0, width: 0, height: 0 }
  })
}

/** A tab with a page is described live; one not opened since the restart, from what was saved. */
function describeTab(tab: SavedTab): BrowserTab {
  const wc = liveContents(tab.id)
  if (!wc) return { id: tab.id, url: tab.url, title: tab.title, loading: false }
  return { id: tab.id, url: sanitizeUrl(wc.getURL()) ?? tab.url, title: wc.getTitle(), loading: wc.isLoading() }
}

export function getBrowserState(scope: string | null): BrowserState {
  const list = scope ? savedTabs[scope] : undefined
  const tab = list?.tabs.find((row) => row.id === list.active)
  const wc = contents(scope)
  const url = wc?.getURL() ?? ''
  return {
    url: sanitizeUrl(url) ?? tab?.url ?? '',
    title: wc ? wc.getTitle() : (tab?.title ?? ''),
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    visible: scope !== null && scope === activeScope && onScreen(),
    error: (tab ? pages.get(tab.id)?.error : null) ?? null,
    tabs: list ? list.tabs.map(describeTab) : [],
    activeTabId: list?.active ?? null
  }
}

/** Switches the window to the active tab of `scope`; a scope used for the first time shows one empty tab. */
export function setBrowserScope(scope: string | null): BrowserState {
  if (scope !== activeScope) {
    if (picking) void cancelBrowserAnnotate()
    activeScope = scope
    if (scope) tabList(scope)
    if (visible && scope) {
      ensurePage(scope)
      loadPersistedIfNeeded(scope)
    }
    applyBounds()
    emit(true)
  }
  return getBrowserState(activeScope)
}

/** After the scope's tabs changed: saves them, and when the scope is on screen shows its active tab. */
function tabsChanged(scope: string): void {
  void writePersisted()
  if (scope !== activeScope) return
  // A pick belongs to the tab it started in.
  if (picking && pickTab !== activeTabId(scope)) void cancelBrowserAnnotate()
  if (visible) {
    ensurePage(scope)
    loadPersistedIfNeeded(scope)
  }
  applyBounds()
  emit(true)
}

/** Opens a new tab at the end of the scope's tabs and selects it, loading `url` when given. */
export async function newBrowserTab(scope: string | null, url?: string): Promise<BrowserState> {
  if (!scope) return getBrowserState(null)
  savedTabs[scope] = addTab(tabList(scope), { id: newId(), url: '', title: '' })
  tabsChanged(scope)
  if (url) return navigateBrowser(scope, url)
  return getBrowserState(scope)
}

export function selectBrowserTab(scope: string | null, tabId: string): BrowserState {
  if (!scope) return getBrowserState(null)
  const list = tabList(scope)
  const next = selectTab(list, tabId)
  if (next.active !== list.active) {
    savedTabs[scope] = next
    tabsChanged(scope)
  }
  return getBrowserState(scope)
}

/** Closes a tab and its page; closing the active one selects its neighbour, closing the last leaves an empty tab. */
export function closeBrowserTab(scope: string | null, tabId: string): BrowserState {
  if (!scope) return getBrowserState(null)
  const list = tabList(scope)
  const next = closeTab(list, tabId, newId)
  if (next === list) return getBrowserState(scope)
  if (picking && pickTab === tabId) void cancelBrowserAnnotate()
  const page = pages.get(tabId)
  pages.delete(tabId)
  if (page) closePage(page)
  savedTabs[scope] = next
  tabsChanged(scope)
  return getBrowserState(scope)
}

export function setBrowserVisible(next: boolean): BrowserState {
  visible = next
  if (next && activeScope) {
    ensurePage(activeScope)
    loadPersistedIfNeeded(activeScope)
  } else if (!next) {
    // Bounds from before a hide are stale; wait for the pane to send fresh ones.
    lastBounds = { x: 0, y: 0, width: 0, height: 0 }
  }
  applyBounds()
  emit(true)
  return getBrowserState(activeScope)
}

export function setBrowserBounds(bounds: BrowserBounds): BrowserState {
  const next = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
  if (
    next.x === lastBounds.x &&
    next.y === lastBounds.y &&
    next.width === lastBounds.width &&
    next.height === lastBounds.height
  ) {
    return getBrowserState(activeScope)
  }
  lastBounds = next
  if (next.width >= 2 && next.height >= 2) paneSize = { width: next.width, height: next.height }
  applyBounds()
  return getBrowserState(activeScope)
}

export async function navigateBrowser(scope: string | null, input: string): Promise<BrowserState> {
  // No project or bot is open, so there is no page to load into.
  if (!scope) return getBrowserState(null)
  const page = ensurePage(scope)
  const url = sanitizeUrl(input)
  if (!url) {
    page.error = 'Enter an http(s) address'
    if (scope === activeScope) emit(true)
    return getBrowserState(scope)
  }
  page.error = null
  // This load replaces the saved page, so opening the pane must not load that one first.
  page.loadedPersisted = true
  requestShowBrowser(scope)
  await savePersisted(scope, activeTab(scope).id, url)
  try {
    await page.view.webContents.loadURL(url)
  } catch {
    // aborted or superseded navigations reject
  }
  return getBrowserState(scope)
}

export function goBack(scope: string | null): BrowserState {
  const wc = contents(scope)
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  return getBrowserState(scope)
}

export function goForward(scope: string | null): BrowserState {
  const wc = contents(scope)
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  return getBrowserState(scope)
}

export function reloadBrowser(scope: string | null): BrowserState {
  contents(scope)?.reload()
  return getBrowserState(scope)
}

export function stopBrowser(scope: string | null): BrowserState {
  contents(scope)?.stop()
  return getBrowserState(scope)
}

/** Opens Chromium DevTools for the page on screen, or closes them when they are open. */
export function toggleBrowserDevTools(): void {
  const wc = contents(activeScope)
  if (!wc) return
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach' })
}

/** Storage is shared by every scope, so clearing it closes every page and leaves each scope one empty tab. */
export async function clearBrowserData(): Promise<BrowserState> {
  const ses = guestSession()
  await ses.clearStorageData()
  await ses.clearCache()
  if (picking) void cancelBrowserAnnotate()
  for (const page of pages.values()) closePage(page)
  pages.clear()
  savedTabs = {}
  if (activeScope) {
    tabList(activeScope)
    if (visible) ensurePage(activeScope)
  }
  applyBounds()
  await writePersisted()
  emit(true)
  return getBrowserState(activeScope)
}

function parseAnnotationHit(
  raw: unknown
): Omit<BrowserAnnotationHit, 'url' | 'title' | 'screenshotData'> | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const rectRaw = row.rect
  if (!rectRaw || typeof rectRaw !== 'object') return null
  const rect = rectRaw as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    selector: typeof row.selector === 'string' ? row.selector : '',
    tag: typeof row.tag === 'string' ? row.tag : '',
    text: typeof row.text === 'string' ? row.text : '',
    html: typeof row.html === 'string' ? row.html : '',
    rect: {
      x: num(rect.x),
      y: num(rect.y),
      width: num(rect.width),
      height: num(rect.height)
    }
  }
}

export async function cancelBrowserAnnotate(): Promise<void> {
  // End the pending start now; the page may never answer (crashed, or replaced mid-pick).
  pickSession += 1
  picking = false
  endPick?.()
  endPick = null
  const wc = liveContents(pickTab)
  if (wc && !wc.isDestroyed()) {
    try {
      await wc.executeJavaScript(ANNOTATE_CANCEL)
    } catch {
      /* page gone */
    }
  }
}

export async function startBrowserAnnotate(): Promise<BrowserAnnotationHit | null> {
  if (picking) await cancelBrowserAnnotate()
  const wc = contents(activeScope)
  if (!wc || wc.isDestroyed()) throw new Error('Browser is not open')
  const url = sanitizeUrl(wc.getURL())
  if (!url) throw new Error('Open a page first')

  const session = ++pickSession
  picking = true
  pickTab = activeTabId(activeScope)
  let raw: unknown = null
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      endPick = () => resolve(null)
      wc.executeJavaScript(ANNOTATE_PICKER, true).then(resolve, reject)
    })
  } finally {
    if (session === pickSession) {
      picking = false
      endPick = null
    }
  }
  // Cancelled, or a newer pick started; the cancel already disarmed this picker.
  if (session !== pickSession) return null

  const parsed = parseAnnotationHit(raw)
  if (!parsed) {
    try {
      await wc.executeJavaScript(ANNOTATE_CLEANUP)
    } catch {
      /* ignore */
    }
    return null
  }

  let screenshotData = ''
  try {
    let image = await wc.capturePage()
    const size = image.getSize()
    if (size.width > 1280) image = image.resize({ width: 1280 })
    screenshotData = image.toPNG().toString('base64')
  } catch {
    screenshotData = ''
  }

  try {
    await wc.executeJavaScript(ANNOTATE_CLEANUP)
  } catch {
    /* ignore */
  }

  return {
    url,
    title: wc.getTitle() || '',
    ...parsed,
    screenshotData
  }
}

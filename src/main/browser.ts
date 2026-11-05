import { app, BrowserWindow, WebContentsView, session } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { BrowserAnnotationHit, BrowserBounds, BrowserState } from '../shared/types'
import { ANNOTATE_CANCEL, ANNOTATE_CLEANUP, ANNOTATE_PICKER } from './annotatePicker'

const PARTITION = 'persist:workbench-browser'

let host: BrowserWindow | null = null
let view: WebContentsView | null = null
let visible = false
let lastError: string | null = null
let lastUrl = ''
let lastBounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
let persistReady: Promise<void> | null = null
let lastEmitted = ''
let emitTimer: ReturnType<typeof setTimeout> | null = null
let loadedPersisted = false
let picking = false

export type ConsoleEntry = { level: string; message: string; source: string; at: string }
const CONSOLE_LIMIT = 200
const consoleEntries: ConsoleEntry[] = []

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

function guestSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  const current = ses.getUserAgent()
  const stripped = current.replace(/\sElectron\/\S+/, '')
  if (stripped !== current) ses.setUserAgent(stripped)
  return ses
}

function contents(): Electron.WebContents | null {
  if (!view || view.webContents.isDestroyed()) return null
  return view.webContents
}

/** The BrowserPane page, created on demand, for tools that read or drive it. */
export function browserContents(): Electron.WebContents {
  return ensureView().webContents
}

/** The page's console since the last navigation, oldest first. */
export function browserConsole(): ConsoleEntry[] {
  return [...consoleEntries]
}

function stateKey(state: BrowserState): string {
  return `${state.url}\0${state.title}\0${state.canGoBack}\0${state.canGoForward}\0${state.loading}\0${state.visible}\0${state.error ?? ''}`
}

function emit(immediate = false): void {
  const send = (): void => {
    emitTimer = null
    const state = getBrowserState()
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

export function requestShowBrowser(): void {
  setBrowserVisible(true)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('browser:requestShow')
  }
}

async function loadPersisted(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(persistPath(), 'utf8')) as { url?: unknown }
    if (typeof raw.url === 'string') {
      lastUrl = sanitizeUrl(raw.url) ?? ''
    }
  } catch {
    lastUrl = ''
  }
}

async function savePersisted(url: string): Promise<void> {
  const clean = sanitizeUrl(url) ?? ''
  lastUrl = clean
  await mkdir(join(app.getPath('userData'), 'workbench'), { recursive: true })
  await writeFile(persistPath(), JSON.stringify({ url: clean }), 'utf8')
}

function applyBounds(): void {
  if (!view) return
  const { x, y, width, height } = lastBounds
  const show = visible && width >= 2 && height >= 2
  view.setVisible(show)
  if (show) view.setBounds({ x, y, width, height })
}

function loadPersistedIfNeeded(): void {
  if (loadedPersisted || !lastUrl) return
  const wc = contents()
  if (!wc) return
  if (sanitizeUrl(wc.getURL())) {
    loadedPersisted = true
    return
  }
  loadedPersisted = true
  void wc.loadURL(lastUrl)
}

function wireContents(wc: Electron.WebContents): void {
  wc.setWindowOpenHandler((details) => {
    const url = sanitizeUrl(details.url)
    if (url) void navigateBrowser(url)
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
    if (sanitizeUrl(url)) void savePersisted(url)
    emit()
  }

  wc.on('console-message', (details) => {
    const where = details.sourceId ? `${details.sourceId}:${details.lineNumber}` : ''
    consoleEntries.push({
      level: details.level,
      message: details.message,
      source: where,
      at: new Date().toISOString()
    })
    if (consoleEntries.length > CONSOLE_LIMIT) consoleEntries.splice(0, consoleEntries.length - CONSOLE_LIMIT)
  })
  wc.on('did-navigate', () => {
    consoleEntries.length = 0
  })
  wc.on('did-navigate', onChange)
  wc.on('did-navigate-in-page', onChange)
  wc.on('page-title-updated', () => emit())
  wc.on('did-start-loading', () => {
    lastError = null
    if (picking) void cancelBrowserAnnotate()
    emit()
  })
  wc.on('did-stop-loading', onChange)
  wc.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    lastError = errorDescription || 'Failed to load'
    emit()
  })
}

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view

  view = new WebContentsView({
    webPreferences: {
      session: guestSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: true
    }
  })
  view.setBackgroundColor('#141414')
  view.setVisible(false)
  wireContents(view.webContents)

  if (host && !host.isDestroyed()) {
    host.contentView.addChildView(view)
  }

  return view
}

export async function prepareBrowser(): Promise<void> {
  persistReady ??= loadPersisted()
  await persistReady
}

function layoutHost(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const [width, height] = window.getContentSize()
  for (const child of window.contentView.children) {
    if (child === view) continue
    child.setBounds({ x: 0, y: 0, width, height })
  }
  applyBounds()
}

export function attachBrowser(window: BrowserWindow): void {
  host = window
  if (visible) {
    const current = ensureView()
    if (!window.contentView.children.includes(current)) {
      window.contentView.addChildView(current)
    }
    loadPersistedIfNeeded()
  }
  layoutHost(window)

  const relayout = (): void => layoutHost(window)
  window.on('resize', relayout)
  window.on('show', relayout)
  window.on('ready-to-show', relayout)
  window.on('enter-full-screen', relayout)
  window.on('leave-full-screen', relayout)

  window.on('closed', () => {
    if (host !== window) return
    if (view && !view.webContents.isDestroyed()) {
      try {
        window.contentView.removeChildView(view)
      } catch {
        // window already tearing down
      }
    }
    view = null
    host = null
    visible = false
  })
}

export function getBrowserState(): BrowserState {
  const wc = contents()
  const url = wc?.getURL() ?? ''
  return {
    url: sanitizeUrl(url) ?? lastUrl,
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    visible,
    error: lastError
  }
}

export function setBrowserVisible(next: boolean): BrowserState {
  visible = next
  if (next) {
    ensureView()
    loadPersistedIfNeeded()
  }
  applyBounds()
  emit(true)
  return getBrowserState()
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
    return getBrowserState()
  }
  lastBounds = next
  applyBounds()
  return getBrowserState()
}

export async function navigateBrowser(input: string): Promise<BrowserState> {
  const url = sanitizeUrl(input)
  if (!url) {
    lastError = 'Enter an http(s) address'
    emit(true)
    return getBrowserState()
  }
  lastError = null
  requestShowBrowser()
  await savePersisted(url)
  const wc = ensureView().webContents
  try {
    await wc.loadURL(url)
  } catch {
    // aborted or superseded navigations reject
  }
  return getBrowserState()
}

export function goBack(): BrowserState {
  const wc = contents()
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  return getBrowserState()
}

export function goForward(): BrowserState {
  const wc = contents()
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  return getBrowserState()
}

export function reloadBrowser(): BrowserState {
  contents()?.reload()
  return getBrowserState()
}

export function stopBrowser(): BrowserState {
  contents()?.stop()
  return getBrowserState()
}

export async function clearBrowserData(): Promise<BrowserState> {
  const ses = guestSession()
  await ses.clearStorageData()
  await ses.clearCache()
  lastUrl = ''
  lastError = null
  loadedPersisted = false
  await savePersisted('')
  const wc = contents()
  if (wc) {
    try {
      await wc.loadURL('about:blank')
    } catch {
      // ignored
    }
  }
  emit(true)
  return getBrowserState()
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
  const wc = contents()
  if (wc && !wc.isDestroyed()) {
    try {
      await wc.executeJavaScript(ANNOTATE_CANCEL)
    } catch {
      /* page gone */
    }
  }
  picking = false
}

export async function startBrowserAnnotate(): Promise<BrowserAnnotationHit | null> {
  if (picking) await cancelBrowserAnnotate()
  const wc = contents()
  if (!wc || wc.isDestroyed()) throw new Error('Browser is not open')
  const url = sanitizeUrl(wc.getURL())
  if (!url) throw new Error('Open a page first')

  picking = true
  let raw: unknown = null
  try {
    raw = await wc.executeJavaScript(ANNOTATE_PICKER, true)
  } catch (error) {
    picking = false
    throw error
  }
  if (!picking) return null
  picking = false

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

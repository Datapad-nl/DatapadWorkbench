import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/** An app left open for days still finds new releases. */
const CHECK_EVERY_MS = 4 * 60 * 60_000

let state: UpdateState = { status: app.isPackaged ? 'idle' : 'unsupported' }
const listeners = new Set<(state: UpdateState) => void>()
let checkTimer: ReturnType<typeof setInterval> | null = null

function emit(next: UpdateState): void {
  state = next
  for (const listener of listeners) listener(next)
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateState(listener: (state: UpdateState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Installed builds fetch new GitHub releases in the background and install them on quit. */
export function startUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.on('checking-for-update', () => emit({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => emit({ status: 'latest' }))
  autoUpdater.on('update-available', (info) => emit({ status: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') emit({ ...state, percent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info) => emit({ status: 'ready', version: info.version }))
  autoUpdater.on('error', (error) => {
    console.error('auto update', error)
    // A downloaded update stays installable when a later check fails.
    if (state.status === 'ready') return
    emit({ status: 'error', message: error.message })
  })
  checkInBackground()
  checkTimer = setInterval(checkInBackground, CHECK_EVERY_MS)
}

export function stopUpdater(): void {
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = null
}

/** A check or download is already under way, or the update only needs a restart. */
function isBusy(): boolean {
  return state.status === 'checking' || state.status === 'downloading' || state.status === 'ready'
}

function checkInBackground(): void {
  if (isBusy()) return
  void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  if (isBusy()) return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // The error event usually reports it already. The events update state while this awaits.
    const status = getUpdateState().status
    if (status !== 'error' && status !== 'ready') {
      emit({ status: 'error', message: error instanceof Error ? error.message : 'Could not check for updates' })
    }
  }
  return state
}

export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall()
}

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

let state: UpdateState = { status: app.isPackaged ? 'idle' : 'unsupported' }
const listeners = new Set<(state: UpdateState) => void>()

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
    emit({ status: 'error', message: error.message })
  })
  void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  // A check or download is already under way, or the update only needs a restart.
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    // The error event usually reports it already. The events update state while this awaits.
    if (getUpdateState().status !== 'error') {
      emit({ status: 'error', message: error instanceof Error ? error.message : 'Could not check for updates' })
    }
  }
  return state
}

export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall()
}

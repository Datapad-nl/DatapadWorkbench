import { app, screen, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const DEFAULT_WIDTH = 1320
const DEFAULT_HEIGHT = 860
const MIN_WIDTH = 960
const MIN_HEIGHT = 640

export type WindowState = {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

function statePath(): string {
  return join(app.getPath('userData'), 'workbench', 'window.json')
}

export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    return sanitize(raw)
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, isMaximized: false }
  }
}

function sanitize(raw: Partial<WindowState>): WindowState {
  const width = Number(raw.width)
  const height = Number(raw.height)
  const state: WindowState = {
    width: Number.isFinite(width) ? Math.max(MIN_WIDTH, Math.round(width)) : DEFAULT_WIDTH,
    height: Number.isFinite(height) ? Math.max(MIN_HEIGHT, Math.round(height)) : DEFAULT_HEIGHT,
    isMaximized: Boolean(raw.isMaximized)
  }
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (Number.isFinite(x) && Number.isFinite(y)) {
    state.x = Math.round(x)
    state.y = Math.round(y)
  }
  if (!isMostlyOnScreen(state)) {
    delete state.x
    delete state.y
  }
  return state
}

function isMostlyOnScreen(state: WindowState): boolean {
  if (state.x == null || state.y == null) return true
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height }
  const area = screen.getDisplayMatching(rect).workArea
  const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const overlapY = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
  return overlapX > 120 && overlapY > 80
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const persist = (): void => {
    if (win.isDestroyed()) return
    const isMaximized = win.isMaximized()
    const bounds = isMaximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    try {
      mkdirSync(join(statePath(), '..'), { recursive: true })
      writeFileSync(
        statePath(),
        JSON.stringify(
          {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized
          } satisfies WindowState,
          null,
          2
        )
      )
    } catch {
      // ignore disk errors
    }
  }

  // A resize or move drag fires many events. Save once it has been still for a moment.
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      persist()
    }, 250)
  }

  // Close saves the final bounds now, so a save still waiting must not run after it.
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    persist()
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', flush)
}

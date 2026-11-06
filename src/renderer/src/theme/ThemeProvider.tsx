import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GRAPHITE_THEME, type ThemeFile, type ThemeSummary } from '../../../shared/theme'
import { applyTheme } from './apply'

export type ThemeState = {
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
}

type ThemeContextValue = {
  ready: boolean
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
  refreshThemes: () => Promise<ThemeState>
  activateTheme: (id: string) => Promise<ThemeState>
  saveTheme: (theme: ThemeFile) => Promise<ThemeState>
  deleteTheme: (id: string) => Promise<ThemeState>
  importTheme: () => Promise<ThemeState | null>
  exportTheme: (id: string) => Promise<boolean>
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function applyState(
  state: ThemeState,
  setActive: (theme: ThemeFile) => void,
  setThemes: (themes: ThemeSummary[]) => void,
  setActiveId: (id: string) => void
): ThemeState {
  setActive(state.active)
  setThemes(state.themes)
  setActiveId(state.activeId)
  applyTheme(state.active)
  return state
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [active, setActive] = useState<ThemeFile>(GRAPHITE_THEME)
  const [themes, setThemes] = useState<ThemeSummary[]>([])
  const [activeId, setActiveId] = useState(GRAPHITE_THEME.id)
  // Calls can resolve out of order. Only the one issued last applies its state.
  const latest = useRef(0)

  const refreshThemes = useCallback(async () => {
    const ticket = ++latest.current
    const state = await window.workbench.getThemeState()
    return ticket === latest.current ? applyState(state, setActive, setThemes, setActiveId) : state
  }, [])

  useEffect(() => {
    void refreshThemes()
      .catch(() => undefined)
      .finally(() => setReady(true))
  }, [refreshThemes])

  // Main sends each change, from any window, before the reply to the call that made it.
  // Taking it as the latest keeps every window on main's newest state.
  useEffect(
    () =>
      window.workbench.onThemeChanged((state) => {
        latest.current += 1
        applyState(state, setActive, setThemes, setActiveId)
      }),
    []
  )

  const activateTheme = useCallback(async (id: string) => {
    const ticket = ++latest.current
    const state = await window.workbench.activateTheme(id)
    return ticket === latest.current ? applyState(state, setActive, setThemes, setActiveId) : state
  }, [])

  const saveTheme = useCallback(async (theme: ThemeFile) => {
    const ticket = ++latest.current
    const state = await window.workbench.saveTheme(theme)
    return ticket === latest.current ? applyState(state, setActive, setThemes, setActiveId) : state
  }, [])

  const deleteTheme = useCallback(async (id: string) => {
    const ticket = ++latest.current
    const state = await window.workbench.deleteTheme(id)
    return ticket === latest.current ? applyState(state, setActive, setThemes, setActiveId) : state
  }, [])

  const importTheme = useCallback(async () => {
    const ticket = ++latest.current
    const state = await window.workbench.importTheme()
    if (!state) return null
    return ticket === latest.current ? applyState(state, setActive, setThemes, setActiveId) : state
  }, [])

  const exportTheme = useCallback(async (id: string) => {
    return window.workbench.exportTheme(id)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      ready,
      active,
      themes,
      activeId,
      refreshThemes,
      activateTheme,
      saveTheme,
      deleteTheme,
      importTheme,
      exportTheme
    }),
    [
      ready,
      active,
      themes,
      activeId,
      refreshThemes,
      activateTheme,
      saveTheme,
      deleteTheme,
      importTheme,
      exportTheme
    ]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}

import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  getBuiltInTheme,
  isBuiltInThemeId,
  parseTheme,
  slugifyThemeId,
  summarizeTheme,
  type ThemeFile,
  type ThemeSummary
} from '../shared/theme'
import { getThemeId, setThemeId } from './store'
import { writeFileAtomic } from './storeIo'

function themesDir(): string {
  return join(app.getPath('userData'), 'workbench', 'themes')
}

function themePath(id: string): string {
  return join(themesDir(), `${id}.json`)
}

async function readJsonUnknown(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

export async function ensureThemesDir(): Promise<void> {
  await mkdir(themesDir(), { recursive: true })
}

async function loadUserTheme(id: string): Promise<ThemeFile | null> {
  if (isBuiltInThemeId(id)) return null
  const raw = await readJsonUnknown(themePath(id))
  if (!raw) return null
  try {
    return parseTheme(raw)
  } catch {
    return null
  }
}

export async function resolveTheme(id: string): Promise<ThemeFile> {
  const builtIn = getBuiltInTheme(id)
  if (builtIn) return builtIn
  const user = await loadUserTheme(id)
  if (user) return user
  return getBuiltInTheme(DEFAULT_THEME_ID) ?? BUILT_IN_THEMES[0]
}

export async function listThemeSummaries(): Promise<ThemeSummary[]> {
  await ensureThemesDir()
  const builtIn = BUILT_IN_THEMES.map((theme) => summarizeTheme(theme, true))
  const names = await readdir(themesDir()).catch(() => [] as string[])
  const user: ThemeSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.workbenchtheme')) continue
    const raw = await readJsonUnknown(join(themesDir(), name))
    if (!raw) continue
    try {
      const theme = parseTheme(raw)
      if (isBuiltInThemeId(theme.id)) continue
      user.push(summarizeTheme(theme, false))
    } catch {
      // skip invalid files
    }
  }
  user.sort((a, b) => a.name.localeCompare(b.name))
  return [...builtIn, ...user]
}

export async function getThemeState(): Promise<{
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
}> {
  const activeId = await getThemeId()
  const active = await resolveTheme(activeId)
  // Only a theme that is gone resets the choice. One that fails to read this time is kept.
  if (active.id !== activeId && !existsSync(themePath(activeId))) {
    await setThemeId(active.id)
  }
  return {
    active,
    themes: await listThemeSummaries(),
    activeId: active.id
  }
}

export async function activateTheme(id: string): Promise<{
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
}> {
  const theme = await resolveTheme(id)
  await setThemeId(theme.id)
  applyWindowChrome(theme)
  return getThemeState()
}

export async function saveUserTheme(raw: unknown): Promise<{
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
}> {
  const parsed = parseTheme(raw)
  const theme = isBuiltInThemeId(parsed.id)
    ? { ...parsed, id: await uniqueUserId(parsed.name) }
    : parsed
  await ensureThemesDir()
  await writeFileAtomic(themePath(theme.id), JSON.stringify(theme, null, 2))
  await setThemeId(theme.id)
  applyWindowChrome(theme)
  return getThemeState()
}

export async function deleteUserTheme(id: string): Promise<{
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
}> {
  if (isBuiltInThemeId(id)) throw new Error('Built-in themes cannot be deleted')
  await rm(themePath(id), { force: true })
  const current = await getThemeId()
  if (current === id) {
    await setThemeId(DEFAULT_THEME_ID)
  }
  const state = await getThemeState()
  applyWindowChrome(state.active)
  return state
}

async function uniqueUserId(base: string): Promise<string> {
  let id = slugifyThemeId(base)
  let n = 2
  while (isBuiltInThemeId(id) || (await loadUserTheme(id))) {
    id = `${slugifyThemeId(base)}-${n}`
    n += 1
  }
  return id
}

export async function importThemeFile(): Promise<{
  active: ThemeFile
  themes: ThemeSummary[]
  activeId: string
} | null> {
  const window = BrowserWindow.getFocusedWindow()
  const options = {
    title: 'Load theme',
    filters: [
      { name: 'Datapad Workbench Theme', extensions: ['json', 'workbenchtheme'] },
      { name: 'All files', extensions: ['*'] }
    ],
    properties: ['openFile' as const]
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  const raw = await readJsonUnknown(result.filePaths[0])
  if (!raw) throw new Error('Could not read that theme file')
  const parsed = parseTheme(raw)
  const id = isBuiltInThemeId(parsed.id) || (await loadUserTheme(parsed.id))
    ? await uniqueUserId(parsed.name)
    : parsed.id
  const theme: ThemeFile = { ...parsed, id }
  await ensureThemesDir()
  await writeFileAtomic(themePath(theme.id), JSON.stringify(theme, null, 2))
  await setThemeId(theme.id)
  applyWindowChrome(theme)
  return getThemeState()
}

export async function exportThemeFile(id: string): Promise<boolean> {
  const theme = await resolveTheme(id)
  const window = BrowserWindow.getFocusedWindow()
  const options = {
    title: 'Save theme',
    defaultPath: `${theme.id}.json`,
    filters: [
      { name: 'Datapad Workbench Theme', extensions: ['json', 'workbenchtheme'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  const target = result.filePath.endsWith('.json') || result.filePath.endsWith('.workbenchtheme')
    ? result.filePath
    : `${result.filePath}.json`
  await writeFile(target, JSON.stringify(theme, null, 2), 'utf8')
  return true
}

export function applyWindowChrome(theme: ThemeFile): void {
  const color = theme.colors.canvas.startsWith('#') ? theme.colors.canvas : '#141414'
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(color)
  }
}



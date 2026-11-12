export const THEME_VERSION = 1 as const

export type ThemeColors = {
  canvas: string
  sidebar: string
  surface: string
  raised: string
  line: string
  ink: string
  muted: string
  accent: string
  accentInk: string
  danger: string
  active: string
  overlay: string
  code: string
  codeBlock: string
  diffAdd: string
  diffAddBg: string
  diffDel: string
  diffDelBg: string
  scrollbar: string
  scrollbarHover: string
}

export type ThemeFonts = {
  sans: string
  mono: string
  display: string
  urls: string[]
}

export type ThemeRadii = {
  sm: number
  md: number
  lg: number
}

export type ThemeFile = {
  version: typeof THEME_VERSION
  id: string
  name: string
  description?: string
  colors: ThemeColors
  fonts: ThemeFonts
  radii: ThemeRadii
}

export type ThemeSummary = {
  id: string
  name: string
  description?: string
  builtIn: boolean
}

export const COLOR_KEYS = [
  'canvas',
  'sidebar',
  'surface',
  'raised',
  'line',
  'ink',
  'muted',
  'accent',
  'accentInk',
  'danger',
  'active',
  'overlay',
  'code',
  'codeBlock',
  'diffAdd',
  'diffAddBg',
  'diffDel',
  'diffDelBg',
  'scrollbar',
  'scrollbarHover'
] as const

export const COLOR_GROUPS: { label: string; keys: (keyof ThemeColors)[] }[] = [
  {
    label: 'Surfaces',
    keys: ['canvas', 'sidebar', 'surface', 'raised', 'line', 'overlay']
  },
  {
    label: 'Ink & marks',
    keys: ['ink', 'muted', 'accent', 'accentInk', 'danger', 'active']
  },
  {
    label: 'Code & diff',
    keys: ['code', 'codeBlock', 'diffAdd', 'diffAddBg', 'diffDel', 'diffDelBg']
  },
  {
    label: 'Chrome',
    keys: ['scrollbar', 'scrollbarHover']
  }
]

export const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  canvas: 'Canvas',
  sidebar: 'Sidebar',
  surface: 'Surface',
  raised: 'Raised',
  line: 'Hairline',
  ink: 'Ink',
  muted: 'Muted',
  accent: 'Accent',
  accentInk: 'Ink on accent',
  danger: 'Danger',
  active: 'Active row',
  overlay: 'Modal overlay',
  code: 'Inline code',
  codeBlock: 'Code block',
  diffAdd: 'Diff add text',
  diffAddBg: 'Diff add fill',
  diffDel: 'Diff delete text',
  diffDelBg: 'Diff delete fill',
  scrollbar: 'Scrollbar',
  scrollbarHover: 'Scrollbar hover'
}

const SYSTEM_SANS = '"SF Pro Text", "Segoe UI", system-ui, sans-serif'
const SYSTEM_MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace'

export const GRAPHITE_THEME: ThemeFile = {
  version: 1,
  id: 'graphite',
  name: 'Graphite',
  description: 'The original Workbench charcoal.',
  colors: {
    canvas: '#141414',
    sidebar: '#191919',
    surface: '#1e1e1e',
    raised: '#252525',
    line: '#2c2c2c',
    ink: '#f2f2f0',
    muted: '#8e8e86',
    accent: '#c4a35a',
    accentInk: '#141414',
    danger: '#c45c4a',
    active: '#141414',
    overlay: 'rgba(0, 0, 0, 0.5)',
    code: '#252525',
    codeBlock: '#1a1a1a',
    diffAdd: '#b6efc6',
    diffAddBg: '#1f3d2b',
    diffDel: '#ffb4a8',
    diffDelBg: '#5c2a24',
    scrollbar: '#3a3a3a',
    scrollbarHover: '#4e4e4e'
  },
  fonts: {
    sans: SYSTEM_SANS,
    mono: SYSTEM_MONO,
    display: SYSTEM_SANS,
    urls: []
  },
  radii: { sm: 6, md: 10, lg: 16 }
}

export const BRASS_CONSOLE_THEME: ThemeFile = {
  version: 1,
  id: 'brass-console',
  name: 'Brass Console',
  description: 'Warm instrument. Gold as a mark, not a box.',
  colors: {
    canvas: '#161412',
    sidebar: '#1c1a17',
    surface: '#211e1a',
    raised: '#2a261f',
    line: '#3a342a',
    ink: '#f3ede3',
    muted: '#9a9286',
    accent: '#c4a35a',
    accentInk: '#161412',
    danger: '#c45c4a',
    active: '#3d3424',
    overlay: 'rgba(12, 10, 8, 0.55)',
    code: '#2a261f',
    codeBlock: '#1a1814',
    diffAdd: '#b7d4b0',
    diffAddBg: '#243326',
    diffDel: '#e0b4aa',
    diffDelBg: '#3d2824',
    scrollbar: '#3a342a',
    scrollbarHover: '#524a3c'
  },
  fonts: {
    sans: 'Outfit, ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    display: 'Outfit, ui-sans-serif, system-ui, sans-serif',
    urls: [
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@400;500;600;700&display=swap'
    ]
  },
  radii: { sm: 6, md: 10, lg: 14 }
}

export const SIGNAL_NIGHT_THEME: ThemeFile = {
  version: 1,
  id: 'signal-night',
  name: 'Signal Night',
  description: 'Cool zinc. Quiet brass. Product chrome.',
  colors: {
    canvas: '#0f0f10',
    sidebar: '#141416',
    surface: '#18181b',
    raised: '#1f1f23',
    line: 'rgba(255, 255, 255, 0.08)',
    ink: '#f4f4f5',
    muted: '#71717a',
    accent: '#b08d4a',
    accentInk: '#0f0f10',
    danger: '#e2553d',
    active: '#1f1f23',
    overlay: 'rgba(0, 0, 0, 0.55)',
    code: '#27272a',
    codeBlock: '#111113',
    diffAdd: '#86efac',
    diffAddBg: '#14532d',
    diffDel: '#fca5a5',
    diffDelBg: '#7f1d1d',
    scrollbar: '#3f3f46',
    scrollbarHover: '#52525b'
  },
  fonts: {
    sans: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    display: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
    urls: [
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap'
    ]
  },
  radii: { sm: 4, md: 8, lg: 12 }
}

export const WARM_ATELIER_THEME: ThemeFile = {
  version: 1,
  id: 'warm-atelier',
  name: 'Warm Atelier',
  description: 'Night studio. Serif dossier. Editorial center.',
  colors: {
    canvas: '#141210',
    sidebar: '#1a1815',
    surface: '#1e1b17',
    raised: '#26221c',
    line: '#3d372e',
    ink: '#f6f1e8',
    muted: '#a39888',
    accent: '#c9a36a',
    accentInk: '#141210',
    danger: '#c45c4a',
    active: '#2c261e',
    overlay: 'rgba(10, 8, 6, 0.55)',
    code: '#26221c',
    codeBlock: '#181614',
    diffAdd: '#c5d4b0',
    diffAddBg: '#2a2e22',
    diffDel: '#e0c4b4',
    diffDelBg: '#3a2a24',
    scrollbar: '#3d372e',
    scrollbarHover: '#534b40'
  },
  fonts: {
    sans: 'Outfit, ui-sans-serif, system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    display: '"Instrument Serif", "Iowan Old Style", Palatino, serif',
    urls: [
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif&family=Outfit:wght@400;500;600;700&display=swap'
    ]
  },
  radii: { sm: 8, md: 12, lg: 20 }
}

/** The look of the knowledge graph, for the whole app. */
export const CONSTELLATION_THEME: ThemeFile = {
  version: 1,
  id: 'constellation',
  name: 'Constellation',
  description: 'The knowledge graph at night. Deep navy, ember lines, glow.',
  colors: {
    canvas: '#070a12',
    sidebar: '#0a0e18',
    surface: '#0e1420',
    raised: '#151d2c',
    line: 'rgba(255, 154, 60, 0.18)',
    ink: '#f1ece2',
    muted: '#9aa3b5',
    accent: '#ff9a3c',
    accentInk: '#070a12',
    danger: '#e8502a',
    active: '#182236',
    overlay: 'rgba(4, 6, 12, 0.66)',
    code: '#151d2c',
    codeBlock: '#0a0e18',
    diffAdd: '#9fe3b4',
    diffAddBg: '#12301f',
    diffDel: '#ffb4a8',
    diffDelBg: '#4a1f1a',
    scrollbar: 'rgba(255, 154, 60, 0.3)',
    scrollbarHover: 'rgba(255, 154, 60, 0.5)'
  },
  fonts: {
    sans: SYSTEM_SANS,
    mono: SYSTEM_MONO,
    display: SYSTEM_SANS,
    urls: []
  },
  radii: { sm: 0, md: 0, lg: 0 }
}

export const BUILT_IN_THEMES: ThemeFile[] = [
  GRAPHITE_THEME,
  BRASS_CONSOLE_THEME,
  SIGNAL_NIGHT_THEME,
  WARM_ATELIER_THEME,
  CONSTELLATION_THEME
]

export const DEFAULT_THEME_ID = CONSTELLATION_THEME.id

const builtInById = new Map(BUILT_IN_THEMES.map((theme) => [theme.id, theme]))

export function isBuiltInThemeId(id: string): boolean {
  return builtInById.has(id)
}

export function getBuiltInTheme(id: string): ThemeFile | null {
  return builtInById.get(id) ?? null
}

export function slugifyThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'theme'
}

export function cloneTheme(theme: ThemeFile, patch: Partial<Pick<ThemeFile, 'id' | 'name' | 'description'>>): ThemeFile {
  return {
    version: THEME_VERSION,
    id: patch.id ?? theme.id,
    name: patch.name ?? theme.name,
    description: patch.description ?? theme.description,
    colors: { ...theme.colors },
    fonts: { ...theme.fonts, urls: [...theme.fonts.urls] },
    radii: { ...theme.radii }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const next = value.trim()
  return next ? next : null
}

function readRadius(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(32, Math.max(0, Math.round(n)))
}

export function parseTheme(raw: unknown): ThemeFile {
  if (!isRecord(raw)) throw new Error('Theme file must be a JSON object')

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled theme'
  const idRaw = typeof raw.id === 'string' ? raw.id : name
  const id = slugifyThemeId(idRaw)
  const description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined

  const colorsIn = isRecord(raw.colors) ? raw.colors : {}
  const fontsIn = isRecord(raw.fonts) ? raw.fonts : {}
  const radiiIn = isRecord(raw.radii) ? raw.radii : {}

  const colors = { ...GRAPHITE_THEME.colors }
  for (const key of COLOR_KEYS) {
    const parsed = readColor(colorsIn[key])
    if (parsed) colors[key] = parsed
  }

  const urlsRaw = fontsIn.urls
  const urls = Array.isArray(urlsRaw)
    ? urlsRaw.filter((item): item is string => typeof item === 'string' && /^https:\/\//.test(item.trim()))
        .map((item) => item.trim())
    : GRAPHITE_THEME.fonts.urls

  return {
    version: THEME_VERSION,
    id,
    name,
    description,
    colors,
    fonts: {
      sans: readColor(fontsIn.sans) ?? GRAPHITE_THEME.fonts.sans,
      mono: readColor(fontsIn.mono) ?? GRAPHITE_THEME.fonts.mono,
      display: readColor(fontsIn.display) ?? GRAPHITE_THEME.fonts.display,
      urls
    },
    radii: {
      sm: readRadius(radiiIn.sm, GRAPHITE_THEME.radii.sm),
      md: readRadius(radiiIn.md, GRAPHITE_THEME.radii.md),
      lg: readRadius(radiiIn.lg, GRAPHITE_THEME.radii.lg)
    }
  }
}

export function summarizeTheme(theme: ThemeFile, builtIn: boolean): ThemeSummary {
  return {
    id: theme.id,
    name: theme.name,
    description: theme.description,
    builtIn
  }
}

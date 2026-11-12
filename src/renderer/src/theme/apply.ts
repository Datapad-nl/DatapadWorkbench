import type { ThemeFile } from '../../../shared/theme'

const FONT_LINK = 'data-grok-theme-font'

export function applyTheme(theme: ThemeFile): void {
  const root = document.documentElement
  const { colors, fonts, radii } = theme

  // For the effects in globals.css that belong to one theme.
  root.dataset.theme = theme.id

  root.style.setProperty('--color-canvas', colors.canvas)
  root.style.setProperty('--color-sidebar', colors.sidebar)
  root.style.setProperty('--color-surface', colors.surface)
  root.style.setProperty('--color-raised', colors.raised)
  root.style.setProperty('--color-line', colors.line)
  root.style.setProperty('--color-ink', colors.ink)
  root.style.setProperty('--color-muted', colors.muted)
  root.style.setProperty('--color-accent', colors.accent)
  root.style.setProperty('--color-accent-ink', colors.accentInk)
  root.style.setProperty('--color-danger', colors.danger)
  root.style.setProperty('--color-active', colors.active)
  root.style.setProperty('--color-overlay', colors.overlay)
  root.style.setProperty('--color-code', colors.code)
  root.style.setProperty('--color-code-block', colors.codeBlock)
  root.style.setProperty('--color-diff-add', colors.diffAdd)
  root.style.setProperty('--color-diff-add-bg', colors.diffAddBg)
  root.style.setProperty('--color-diff-del', colors.diffDel)
  root.style.setProperty('--color-diff-del-bg', colors.diffDelBg)
  root.style.setProperty('--color-scrollbar', colors.scrollbar)
  root.style.setProperty('--color-scrollbar-hover', colors.scrollbarHover)

  root.style.setProperty('--font-sans', fonts.sans)
  root.style.setProperty('--font-mono', fonts.mono)
  root.style.setProperty('--font-display', fonts.display)

  root.style.setProperty('--radius-sm', `${radii.sm}px`)
  root.style.setProperty('--radius-md', `${radii.sm}px`)
  root.style.setProperty('--radius-lg', `${radii.md}px`)
  root.style.setProperty('--radius-xl', `${Math.round((radii.md + radii.lg) / 2)}px`)
  root.style.setProperty('--radius-2xl', `${radii.lg}px`)

  syncFontLinks(fonts.urls)
}

function syncFontLinks(urls: string[]): void {
  const existing = document.querySelectorAll(`link[${FONT_LINK}]`)
  existing.forEach((node) => node.remove())
  for (const url of urls) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = url
    link.setAttribute(FONT_LINK, '1')
    document.head.appendChild(link)
  }
}

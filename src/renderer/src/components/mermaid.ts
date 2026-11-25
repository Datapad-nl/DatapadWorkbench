import { useEffect, useState, useSyncExternalStore } from 'react'

type HastCode = { tagName?: string; properties?: { className?: unknown }; children?: Array<{ value?: unknown }> }

/** The source of a fenced `mermaid` block, from the `pre` node react-markdown passes. */
export function mermaidSource(node: unknown): string | null {
  const code = (node as { children?: HastCode[] })?.children?.[0]
  if (code?.tagName !== 'code') return null
  const classes = code.properties?.className
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null
  const value = code.children?.[0]?.value
  return typeof value === 'string' ? value.replace(/\n$/, '') : null
}

/** Whether a computed `rgb()` / `rgba()` colour is dark. Any other form counts as dark, the app's default. */
export function isDarkColor(color: string): boolean {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color)
  if (!match) return true
  const [r, g, b] = match.slice(1, 4).map(Number)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

// applyTheme sets the theme's colours on <html>, so a change to its attributes may be a new theme.
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
  return () => observer.disconnect()
}

function darkTheme(): boolean {
  return isDarkColor(getComputedStyle(document.body).backgroundColor)
}

let renders = 0

async function renderMermaid(source: string, dark: boolean): Promise<string | null> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    // The diagram comes from an agent: no click handlers, no HTML in labels.
    securityLevel: 'strict',
    // Without this a failed render leaves mermaid's error graphic in the page.
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sans')
  })
  if (!(await mermaid.parse(source, { suppressErrors: true }))) return null
  try {
    const { svg } = await mermaid.render(`mermaid-${++renders}`, source)
    return svg
  } catch {
    return null
  }
}

/**
 * The SVG for a mermaid source, or null while it does not render. A reply streams in, so the
 * source is usually incomplete: it waits for the text to settle before it tries again.
 */
export function useMermaidSvg(source: string): string | null {
  const dark = useSyncExternalStore(subscribeTheme, darkTheme)
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      void renderMermaid(source, dark).then(
        (result) => {
          if (current) setSvg(result)
        },
        () => {
          if (current) setSvg(null)
        }
      )
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [source, dark])
  return svg
}

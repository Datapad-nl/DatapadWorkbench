import { marked } from 'marked'
import { basename, extname } from 'path'

/** What is read into memory to show a markdown or text file. */
export const TEXT_LIMIT = 4 * 1024 * 1024

// An opaque origin, so a page cannot read the chat's other files with fetch.
export const FILE_CSP = 'sandbox allow-scripts'
// Markdown may hold raw HTML, so its page runs no script at all.
export const PAGE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src workbench-file: https: data:',
  'media-src workbench-file:'
].join('; ')

const RAW_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf'
}

// Shown as text even when they are not valid UTF-8, such as a CSV saved in Latin-1.
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'sql'])

export type FileViewKind = { kind: 'markdown' } | { kind: 'raw'; type: string } | { kind: 'other' }

/** Markdown is rendered, what the pane shows natively is served as is, the rest is decided by its bytes. */
export function fileViewKind(name: string): FileViewKind {
  const ext = extname(name).slice(1).toLowerCase()
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown' }
  if (RAW_TYPES[ext]) return { kind: 'raw', type: RAW_TYPES[ext] }
  return { kind: 'other' }
}

/** Whether a file of no known kind is shown as text: a known text extension, or UTF-8 with no NUL. */
export function isText(name: string, bytes: Uint8Array): boolean {
  if (TEXT_EXT.has(extname(name).slice(1).toLowerCase())) return true
  if (bytes.includes(0)) return false
  try {
    // `stream` leaves a character cut off at the read limit undecoded instead of failing on it.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

function megabytes(size: number): string {
  return `${Math.round(size / (1024 * 1024))} MB`
}

export function cutNote(size: number): string {
  return `Only the first ${megabytes(TEXT_LIMIT)} of this ${megabytes(size)} file is shown.`
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e6e6; --muted: #9a9a9a; --bg: #141414; --line: #333333; --code: #1e1e1e; --link: #6cb6ff; }
}
html { background: var(--bg); color: var(--fg); }
body { max-width: 820px; margin: 0 auto; padding: 32px 28px 64px; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.25em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
img, video { max-width: 100%; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.875em; }
code { background: var(--code); padding: 0.15em 0.35em; border-radius: 5px; }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x: auto; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 1em; }
blockquote { margin-left: 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 13px; }
th { font-weight: 600; background: var(--code); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
.note { color: var(--muted); font-size: 0.9em; }
`

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

/** A markdown file as a page; `size` is the whole file's, to say when only the start of it was read. */
export function markdownPage(path: string, source: string, size: number): string {
  const note = size > TEXT_LIMIT ? `<p class="note">${escapeHtml(cutNote(size))}</p>` : ''
  return page(basename(path), note + marked.parse(source, { async: false, gfm: true }))
}

export function cannotShowPage(path: string): string {
  const name = basename(path)
  return page(name, `<h1>${escapeHtml(name)}</h1><p class="note">This file cannot be shown here.</p>`)
}

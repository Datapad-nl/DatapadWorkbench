/** Files of a chat's project, shown in the browser pane: `workbench-file://<chatId>/<path in its root>`. */
export const FILE_VIEW_SCHEME = 'workbench-file'

const CHAT_ID = /^[a-z0-9-]{1,64}$/i

export function fileViewUrl(chatId: string, relPath: string): string | null {
  if (!CHAT_ID.test(chatId)) return null
  const segments = relPath.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0 || segments.some((part) => part === '.' || part === '..')) return null
  return `${FILE_VIEW_SCHEME}://${chatId.toLowerCase()}/${segments.map(encodeURIComponent).join('/')}`
}

/** The chat and the path in its root, or null for anything that is not a well-formed file view address. */
export function parseFileViewUrl(input: string): { chatId: string; path: string } | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== `${FILE_VIEW_SCHEME}:` || !CHAT_ID.test(url.hostname)) return null
  if (url.username || url.password || url.port) return null
  const segments: string[] = []
  for (const raw of url.pathname.split('/')) {
    if (!raw) continue
    let part: string
    try {
      part = decodeURIComponent(raw)
    } catch {
      return null
    }
    // An encoded separator, dot segment or NUL would let a segment step out of the path it is in.
    if (part === '.' || part === '..' || /[\\/\0]/.test(part)) return null
    segments.push(part)
  }
  if (segments.length === 0) return null
  return { chatId: url.hostname.toLowerCase(), path: segments.join('/') }
}

/** `src/app.ts:12` or `src/app.ts:12:4` as the file it names. */
export function stripLineSuffix(src: string): string {
  return src.trim().replace(/:\d+(?::\d+)?$/, '')
}

/**
 * Whether inline code reads as a path, worth asking the main process about: one word of path characters,
 * with a slash or a file extension that has a letter in it, and an optional `:line`.
 */
export function looksLikeFilePath(text: string): boolean {
  if (text.length === 0 || text.length > 300 || /\s/.test(text)) return false
  const path = stripLineSuffix(text)
  if (!/^[\p{L}\p{N}_.\-/\\~@+[\]]+$/u.test(path) || !/[\p{L}\p{N}]/u.test(path)) return false
  if (/[\\/]/.test(path)) return true
  return /\.[a-z0-9]*[a-z][a-z0-9]*$/i.test(path) && path.length - path.lastIndexOf('.') <= 11
}

/** A link in a reply to a file of the project: no scheme, not an anchor on the page, without its query or hash. */
export function localLinkSrc(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  const path = trimmed.split(/[?#]/)[0]
  if (!path) return null
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

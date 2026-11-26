import { FILE_VIEW_SCHEME, parseFileViewUrl } from '../shared/fileView'

/** An http(s) address, with `https://` added to a bare host. Anything else is null. */
export function sanitizeWebUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const raw = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

/** What the browser pane may show: a web address, or a project file as a `workbench-file:` address. */
export function sanitizeUrl(input: string): string | null {
  const web = sanitizeWebUrl(input)
  if (web) return web
  const trimmed = input.trim()
  if (!parseFileViewUrl(trimmed)) return null
  return new URL(trimmed).href
}

export function isFileViewUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith(`${FILE_VIEW_SCHEME}:`)
}

/** Whether two pane addresses show the same page; file views compare by chat and decoded path. */
export function sameAddress(a: string, b: string): boolean {
  const left = parseFileViewUrl(a)
  const right = parseFileViewUrl(b)
  if (left && right) return left.chatId === right.chatId && left.path === right.path
  return a === b
}

/** A page may go to another page, but only a project file goes to a project file: a web page cannot open one. */
export function allowedNavigation(from: string, to: string): string | null {
  const clean = sanitizeUrl(to)
  if (!clean) return null
  if (isFileViewUrl(clean) && !isFileViewUrl(from)) return null
  return clean
}

/** A page's tab title; a project file without a title of its own, as plain text is, goes by its file name. */
export function pageTitle(url: string, title: string): string {
  if (title && title !== url) return title
  const file = parseFileViewUrl(url)
  return file ? (file.path.split('/').at(-1) ?? title) : title
}

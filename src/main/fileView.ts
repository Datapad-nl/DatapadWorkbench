import { net } from 'electron'
import { open, stat } from 'fs/promises'
import { relative } from 'path'
import { pathToFileURL } from 'url'
import { FILE_VIEW_SCHEME, fileViewUrl, parseFileViewUrl, stripLineSuffix } from '../shared/fileView'
import { activeBrowserScope, guestSession, openInBrowserTab } from './browser'
import {
  FILE_CSP,
  PAGE_CSP,
  TEXT_LIMIT,
  cannotShowPage,
  cutNote,
  fileViewKind,
  isText,
  markdownPage
} from './fileViewPage'
import { resolveRootFile } from './mediaFiles'
import { chatMediaRoots } from './store'

export function fileViewSchemePrivilege(): {
  scheme: string
  privileges: { standard: boolean; secure: boolean; stream: boolean }
} {
  return { scheme: FILE_VIEW_SCHEME, privileges: { standard: true, secure: true, stream: true } }
}

function headers(type: string, csp: string | null = FILE_CSP): Record<string, string> {
  const base = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }
  return csp ? { ...base, 'Content-Security-Policy': csp } : base
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: headers('text/html; charset=utf-8', PAGE_CSP) })
}

async function readStart(file: string, size: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, TEXT_LIMIT))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function serve(request: Request): Promise<Response> {
  const target = parseFileViewUrl(request.url)
  if (!target) return html('Bad request', 400)
  const found = resolveRootFile(await chatMediaRoots(target.chatId), `./${target.path}`)
  if (!found) return html('Not found', 404)
  const { file } = found
  const kind = fileViewKind(file)
  if (kind.kind === 'raw') {
    const res = await net.fetch(pathToFileURL(file).href)
    // Chromium's PDF viewer is a plugin that neither a sandboxed page nor `object-src 'none'` may load.
    // A PDF runs no script in the page's origin.
    const csp = kind.type === 'application/pdf' ? null : FILE_CSP
    return new Response(res.body, { status: res.status, headers: headers(kind.type, csp) })
  }
  const { size } = await stat(file)
  const bytes = await readStart(file, size)
  if (kind.kind === 'markdown') return html(markdownPage(target.path, bytes.toString('utf8'), size))
  if (!isText(file, bytes)) return html(cannotShowPage(target.path))
  const text = size > TEXT_LIMIT ? `${bytes.toString('utf8')}\n\n[${cutNote(size)}]\n` : new Uint8Array(bytes)
  return new Response(text, { headers: headers('text/plain; charset=utf-8') })
}

/** Serves the chat's files to the pane's pages, which run in their own session. */
export function attachFileViewProtocol(): void {
  guestSession().protocol.handle(FILE_VIEW_SCHEME, async (request) => {
    try {
      return await serve(request)
    } catch {
      return html('This file could not be read.', 500)
    }
  })
}

async function locate(chatId: string, src: string, roots?: string[]): Promise<string | null> {
  const found = resolveRootFile(roots ?? (await chatMediaRoots(chatId)), stripLineSuffix(src))
  return found ? fileViewUrl(chatId, relative(found.root, found.file)) : null
}

/** Opens a file a chat mentions in the pane. False when it is no file inside the chat's folders. */
export async function openChatFile(chatId: string, src: string): Promise<boolean> {
  const url = await locate(chatId, src)
  return url ? openInBrowserTab(activeBrowserScope(), url) : false
}

/** For each source, whether it is a file inside the chat's folders the pane could open. */
export async function chatFilesResolvable(chatId: string, srcs: string[]): Promise<boolean[]> {
  const roots = await chatMediaRoots(chatId)
  return Promise.all(srcs.map(async (src) => Boolean(await locate(chatId, src, roots))))
}

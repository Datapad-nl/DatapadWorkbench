import { net, protocol, shell } from 'electron'
import { pathToFileURL } from 'url'
import { chatMediaRoots } from './store'
import { resolveMediaFile } from './mediaFiles'

export const MEDIA_SCHEME = 'workbench-media'

export function mediaSchemePrivilege(): {
  scheme: string
  privileges: {
    standard: boolean
    secure: boolean
    supportFetchAPI: boolean
    corsEnabled: boolean
    stream: boolean
    bypassCSP: boolean
  }
} {
  return {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
}

export function attachMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let chatId = ''
    let src = ''
    try {
      const url = new URL(request.url)
      chatId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      src = url.searchParams.get('src') ?? ''
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const file = resolveMediaFile(await chatMediaRoots(chatId), src)
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).href)
  })
}

export async function openChatMedia(chatId: string, src: string): Promise<boolean> {
  const file = resolveMediaFile(await chatMediaRoots(chatId), src)
  if (!file) return false
  return (await shell.openPath(file)) === ''
}

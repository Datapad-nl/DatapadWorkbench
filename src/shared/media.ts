const MEDIA_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'mp4',
  'webm',
  'mov'
])

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov'])

export function mediaExtension(src: string): string | null {
  const clean = src.trim().split(/[?#]/)[0]
  const match = clean.match(/\.([a-z0-9]+)$/i)
  if (!match) return null
  const ext = match[1].toLowerCase()
  return MEDIA_EXT.has(ext) ? ext : null
}

export function isRemoteSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src.trim())
}

export function isMediaSrc(src: string): boolean {
  return mediaExtension(src) != null
}

export function isVideoSrc(src: string): boolean {
  const ext = mediaExtension(src)
  return ext != null && VIDEO_EXT.has(ext)
}

export function mediaUrl(chatId: string, src: string): string {
  return `workbench-media://media/${encodeURIComponent(chatId)}?src=${encodeURIComponent(src)}`
}

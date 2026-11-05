import { nativeImage } from 'electron'
import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { extname, join } from 'path'

const MAX_DEPTH = 4
const MAX_DIRS = 400
const MAX_RAW_BYTES = 256 * 1024
const SIZE = 64

const SKIP_DIRS = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'out',
  'build-output',
  'target',
  'vendor',
  'Pods',
  'coverage',
  'tmp',
  'temp'
])

/** Folders where a plain `icon.png` or `logo.svg` is the project's own icon, not a UI asset. */
const ICON_DIRS = new Set(['', 'resources', 'build', 'public', 'static', 'assets', 'app', 'src/app'])

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
}

/** Lower is better. Null means the file is not a project icon. */
function rank(name: string, dir: string): number | null {
  const lower = name.toLowerCase()
  const ext = extname(lower)
  if (!MIME[ext]) return null
  const base = lower.slice(0, -ext.length)
  // Within a kind, a bitmap scales down best, then SVG, then ICO.
  const format = ext === '.svg' ? 1 : ext === '.ico' ? 2 : 0
  if (ICON_DIRS.has(dir) && (base === 'icon' || base === 'app-icon' || base === 'appicon')) {
    return format
  }
  if (base.startsWith('apple-touch-icon')) return 3
  if (base === 'favicon' || base.startsWith('favicon-')) return 4 + format
  if (ICON_DIRS.has(dir) && base === 'logo') return 7 + format
  return null
}

/** Finds the project's own icon (app icon, favicon or logo) in its usual places. */
async function findIcon(root: string): Promise<string | null> {
  let best: { path: string; score: number } | null = null
  let queue: string[] = ['']
  let visited = 0
  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth += 1) {
    const next: string[] = []
    for (const dir of queue) {
      if (visited >= MAX_DIRS) break
      visited += 1
      let entries: Dirent[]
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) next.push(relative)
          continue
        }
        if (!entry.isFile()) continue
        const value = rank(entry.name, dir)
        // Depth breaks ties, so a root favicon beats one buried in a sub-app.
        const score = value == null ? null : value * 10 + depth
        if (score != null && (!best || score < best.score)) best = { path: relative, score }
      }
    }
    queue = next
  }
  return best ? join(root, best.path) : null
}

async function toDataUrl(file: string): Promise<string | null> {
  const ext = extname(file).toLowerCase()
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const resized = width > SIZE || height > SIZE ? image.resize({ width: SIZE, quality: 'best' }) : image
    return resized.toDataURL()
  }
  const info = await stat(file)
  if (info.size > MAX_RAW_BYTES) return null
  const data = await readFile(file)
  return `data:${MIME[ext]};base64,${data.toString('base64')}`
}

const cache = new Map<string, Promise<string | null>>()

/** The project's icon as a small data URL, or null when the folder has none. */
export function projectIcon(root: string): Promise<string | null> {
  let pending = cache.get(root)
  if (!pending) {
    pending = findIcon(root)
      .then((file) => (file ? toDataUrl(file) : null))
      .catch(() => null)
    cache.set(root, pending)
  }
  return pending
}
